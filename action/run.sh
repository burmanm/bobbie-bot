#!/usr/bin/env bash
# Runs one review-bot command in the action image (C-2, C-3, C-3a).
#
#   run.sh build    build the image once per job (no secrets involved)
#   run.sh run      run $RB_COMMAND in a locked-down container
#
# Inputs arrive as environment variables (never interpolated into this
# script by the workflow), are validated here, and become argv. The
# container gets only the environment it needs: GH_TOKEN for the GitHub
# commands, and the provider key only for `review`. Mounts are explicit;
# the prepared snapshot is mounted read-only.
set -euo pipefail
set -f

image="review-bot-action:local"
fail() { echo "::error title=review-bot::$*" >&2; exit 2; }

if [[ "${1:-}" == build ]]; then
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "image $image already built in this job"
    exit 0
  fi
  docker build --load -t "$image" -f "$GITHUB_ACTION_PATH/Dockerfile" "$GITHUB_ACTION_PATH/.."
  exit 0
fi
[[ "${1:-}" == run ]] || fail "usage: run.sh build|run"

cmd="${RB_COMMAND:-}"
name="${RB_NAME:-main}"
repo="${RB_REPO:-}"
work="${RB_WORK_DIR:-${RUNNER_TEMP:?}/review-bot}"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$ ]] || fail "invalid name: $name"
[[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "invalid repository: $repo"
mkdir -p "$work"
work="$(cd "$work" && pwd -P)"

docker_args=(
  run --rm --init
  --cap-drop ALL --security-opt no-new-privileges
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=2g
  --pids-limit 1024
  --user "$(id -u):$(id -g)"
  -e HOME=/tmp -e PI_OFFLINE=1
  -e GITHUB_ACTIONS -e GITHUB_REPOSITORY -e GITHUB_RUN_ID -e GITHUB_RUN_ATTEMPT
  -e GITHUB_API_URL -e GITHUB_GRAPHQL_URL -e GITHUB_SERVER_URL
)
args=()

need_sha() { [[ "$2" =~ ^[0-9a-f]{40}$ ]] || fail "$1 must be a 40-hex SHA"; }
need_pr() { [[ "$1" =~ ^[1-9][0-9]*$ ]] || fail "pr must be a PR number"; }
# Multi-line `role=value` inputs, one flag per non-empty line.
role_lines() {
  local flag="$1" pattern="$2" text="$3" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ $pattern ]] || fail "invalid $flag value: $line"
    args+=("$flag" "$line")
  done <<< "$text"
}

case "$cmd" in
  gate)
    out="$work/gate-out"
    rm -rf "$out" && mkdir -p "$out"
    : > "$out/output" && : > "$out/summary.md"
    docker_args+=(-e GH_TOKEN -e GITHUB_EVENT_NAME
      -e GITHUB_EVENT_PATH=/github/event.json -e GITHUB_OUTPUT=/github/out/output -e GITHUB_STEP_SUMMARY=/github/out/summary.md
      -v "${GITHUB_EVENT_PATH:?}:/github/event.json:ro" -v "$out:/github/out")
    args=(gate --repo "$repo" --name "$name" --label "${RB_AUTH_LABEL:-ai-review/approved}" --lifetime "${RB_AUTH_LIFETIME:-per-push}")
    if [[ -n "${RB_PR:-}" ]]; then need_pr "$RB_PR"; args+=(--pr "$RB_PR"); fi
    docker "${docker_args[@]}" "$image" "${args[@]}"
    # Pass on only well-formed outputs.
    while IFS= read -r line; do
      if [[ "$line" =~ ^[a-z-]+= && "$line" != *$'\r'* ]]; then echo "$line" >> "${GITHUB_OUTPUT:?}"; else fail "unexpected gate output line"; fi
    done < "$out/output"
    cat "$out/summary.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;

  complete-check)
    need_sha head-sha "${RB_HEAD_SHA:-}"
    outcome="${RB_OUTCOME:-}"
    [[ -z "$outcome" || "$outcome" =~ ^(success|failure|cancelled|skipped)$ ]] || fail "invalid outcome: $outcome"
    docker_args+=(-e GH_TOKEN)
    docker "${docker_args[@]}" "$image" complete-check --repo "$repo" --name "$name" --head-sha "$RB_HEAD_SHA" --outcome "$outcome"
    ;;

  remove-label)
    need_pr "${RB_PR:-}"
    docker_args+=(-e GH_TOKEN)
    docker "${docker_args[@]}" "$image" remove-label --repo "$repo" --pr "$RB_PR" --label "${RB_AUTH_LABEL:-ai-review/approved}"
    ;;

  review)
    need_pr "${RB_PR:-}"
    archive="$work/in/snapshot.tar.gz"
    [[ -f "$archive" ]] || fail "no snapshot archive at $archive (the prepare job did not produce one)"
    # 1. Extract the artifact with the validating extractor. No tokens, no keys.
    rm -rf "$work/snapshot" && mkdir -p "$work/snapshot" "$work/runs"
    docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --read-only \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$work/in:/in:ro" -v "$work/snapshot:/snapshot" \
      "$image" unpack-snapshot --archive /in/snapshot.tar.gz --dest /snapshot

    # 2. Review. The snapshot is mounted read-only; nothing in it is executed.
    args=(review --pr "$repo#$RB_PR" --snapshot-dir /snapshot --runs-dir /runs --name "$name")
    role_lines --model '^(reviewer|verifier)=[^[:space:]]+$' "${RB_MODELS:-}"
    role_lines --thinking '^(reviewer|verifier)=(off|minimal|low|medium|high)$' "${RB_THINKING:-}"
    role_lines --providers '^(reviewer|verifier)=[A-Za-z0-9._,-]+$' "${RB_PROVIDERS:-}"
    if [[ -n "${RB_MAX_COST:-}" ]]; then
      [[ "$RB_MAX_COST" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "invalid max-cost: $RB_MAX_COST"
      args+=(--max-cost "$RB_MAX_COST")
    fi
    docker_args+=(-e GH_TOKEN -v "$work/snapshot:/snapshot:ro" -v "$work/runs:/runs")
    # Provider keys by name, from this step's environment (C-6). Never a GitHub token.
    provider_env="${RB_PROVIDER_ENV:-OPENROUTER_API_KEY}"
    for var in ${provider_env//,/ }; do
      [[ "$var" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fail "invalid provider-env name: $var"
      [[ "$var" =~ ^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_.*|ACTIONS_.*|RUNNER_.*)$ ]] && fail "provider-env cannot pass $var"
      if [[ -n "${!var:-}" ]]; then docker_args+=(-e "$var"); else echo "::warning title=review-bot::$var is not set"; fi
    done

    # The step's own limit, a minute inside the workflow's timeout-minutes so
    # the pipeline gets SIGTERM, completes its check and writes its record.
    minutes="${RB_TIMEOUT_MINUTES:-40}"
    [[ "$minutes" =~ ^[1-9][0-9]*$ ]] || fail "invalid timeout-minutes: $minutes"
    seconds=$(( minutes * 60 > 120 ? minutes * 60 - 60 : minutes * 60 ))
    container="review-bot-$$-${GITHUB_RUN_ID:-local}"
    docker_args+=(--name "$container")
    set +e
    timeout --signal=TERM --kill-after=45 "$seconds" docker "${docker_args[@]}" "$image" "${args[@]}"
    status=$?
    set -e
    docker rm -f "$container" >/dev/null 2>&1 || true
    case "$status" in
      0) ;;
      1) echo "::warning title=review-bot::the review could not complete; ai-review/$name is neutral (see the log and the run record artifact)" ;;
      124|137) echo "::error title=review-bot::the review hit its ${minutes}-minute limit"; exit 1 ;;
      *) exit "$status" ;;
    esac
    ;;

  *)
    fail "unknown command: $cmd"
    ;;
esac
