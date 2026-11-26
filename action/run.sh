#!/usr/bin/env bash
# Runs one review-bot command in the action image (C-2, C-3, C-3a).
#
#   run.sh build    get the image once per job (no secrets involved): pull
#                   the prebuilt image pinned by digest (C-4 "The action
#                   image"), or build action/Dockerfile (development)
#   run.sh run      run $RB_COMMAND in a locked-down container
#
# Inputs arrive as environment variables (never interpolated into this
# script by the workflow), are validated here, and become argv. The
# container gets only the environment it needs: GH_TOKEN for the GitHub
# commands, and the provider key only for `review`. Mounts are explicit;
# the prepared snapshot and the agent directory are mounted read-only.
#
# The operator's agent directory (F-7, RB_AGENT_DIR: a path in the
# repository) comes from the default branch, or from RB_AGENT_DIR_REPO
# (owner/name@<commit SHA>), never from the PR (D-19). The gate fetches it
# through the API into $work/agent/dir and the workflow hands it to the setup
# job as an artifact. `setup` installs its packages there (C-4: network, no
# token, no key, lifecycle scripts off) and packs the result into
# $work/agent-out/agent-dir.tar.gz; the workflow hands that to the review
# job, and `review` expects it in $work/agent-in. The review job downloads
# nothing else (C-3a).
set -euo pipefail
set -f

image="review-bot-action:local"
fail() { echo "::error title=review-bot::$*" >&2; exit 2; }

# A prebuilt image is only ever named by digest: the digest is the content.
digest_ref='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+@sha256:[0-9a-f]{64}$'

if [[ "${1:-}" == build ]]; then
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "image $image already present in this job"
    exit 0
  fi
  # RB_IMAGE (the action's `image` input): empty → action/image.lock when it
  # names a digest, else build; "build" → build from action/Dockerfile; else
  # a digest-pinned reference.
  want="${RB_IMAGE:-}"
  if [[ -z "$want" && -f "$GITHUB_ACTION_PATH/image.lock" ]]; then
    want="$(grep -Ev '^[[:space:]]*(#|$)' "$GITHUB_ACTION_PATH/image.lock" | head -n 1 | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$want" || "$want" == build ]]; then
    echo "building the action image from action/Dockerfile"
    docker build --load -t "$image" -f "$GITHUB_ACTION_PATH/Dockerfile" "$GITHUB_ACTION_PATH/.."
    exit 0
  fi
  [[ "$want" =~ $digest_ref ]] || fail "image must be pinned by digest (<registry>/<name>@sha256:<64 hex>) or be \"build\": $want"
  # Docker checks the content against the digest; nothing else is fetched.
  docker pull --quiet "$want"
  docker tag "$want" "$image"
  echo "using $want"
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

agent_dir="$work/agent/dir"
agent_path="${RB_AGENT_DIR:-}"
if [[ -n "$agent_path" ]]; then
  [[ "$agent_path" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && ! "/$agent_path/" =~ /\.\.?/ ]] || fail "invalid agent-dir (a relative directory in the repository): $agent_path"
fi
# Mount the gate's copy of the agent directory read-only and name it to the CLI.
use_agent_dir() {
  [[ -n "$agent_path" ]] || return 0
  [[ -d "$agent_dir" && ! -L "$agent_dir" ]] || fail "agent-dir is set but $agent_dir is missing (the gate job fetches it; the review job downloads it)"
  docker_args+=(-v "$agent_dir:/agent:ro")
  args+=(--agent-dir /agent)
}
# The review job: extract the setup job's archive (validating extractor,
# no network, no token, no key) and mount the result read-only at /agent,
# the path setup installed under, so pi finds the packages where they were
# put (F-7).
use_installed_agent_dir() {
  [[ -n "$agent_path" ]] || return 0
  local in="$work/agent-in" out="$work/agent-installed"
  [[ -f "$in/agent-dir.tar.gz" && ! -L "$in/agent-dir.tar.gz" ]] || fail "agent-dir is set but $in/agent-dir.tar.gz is missing (the setup job makes it; the review job downloads it)"
  rm -rf "$out" && mkdir -p "$out"
  docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$in:/in:ro" -v "$out:/out" \
    "$image" unpack-agent-dir --archive /in/agent-dir.tar.gz --dest /out
  docker_args+=(-v "$out/agent:/agent:ro")
  args+=(--agent-dir /agent)
}
# Prototype for the pilot (R-2): the repository's knowledge (AGENTS.md,
# REVIEW.md, .review/) read from another repository's directory instead of
# the base branch (A-5), so the pilot's files can be edited in one place.
# owner/name[@<40-hex SHA>]:<directory>; without a SHA, that repository's
# default branch head. Never the PR (D-19). It is prompt text, not code. The
# gate fetches it into the agent directory's knowledge/, so it travels to
# the review job with that directory.
knowledge="${RB_KNOWLEDGE:-}"
knowledge_repo="" knowledge_ref="" knowledge_path=""
if [[ -n "$knowledge" ]]; then
  [[ -n "$agent_path" ]] || fail "knowledge needs agent-dir: it travels in the agent directory"
  [[ "$knowledge" =~ ^([A-Za-z0-9-]+/[A-Za-z0-9._-]+)(@([0-9a-f]{40}))?:([A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*)$ ]] || fail "knowledge must be owner/name[@<40-hex commit SHA>]:<directory>: $knowledge"
  knowledge_repo="${BASH_REMATCH[1]}" knowledge_ref="${BASH_REMATCH[3]}" knowledge_path="${BASH_REMATCH[4]}"
  [[ ! "/$knowledge_path/" =~ /\.\.?/ ]] || fail "invalid knowledge directory: $knowledge_path"
fi
# An ACP agent definition (--acp-config): a file in the agent directory, so
# it comes from the default branch like the rest of the configuration (F-7).
acp_config="${RB_ACP_CONFIG:-}"
if [[ -n "$acp_config" ]]; then
  [[ -n "$agent_path" ]] || fail "acp-config needs agent-dir: it names a file in the agent directory"
  [[ "$acp_config" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && ! "/$acp_config/" =~ /\.\.?/ ]] || fail "invalid acp-config (a file in the agent directory): $acp_config"
fi
# fetch-agent-dir into $work/agent (mounted at /agent-out), with GH_TOKEN only.
fetch_dir() {
  docker run --rm --init --cap-drop ALL --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m --user "$(id -u):$(id -g)" -e HOME=/tmp -e GH_TOKEN -e GITHUB_API_URL \
    -v "$work/agent:/agent-out" "$image" fetch-agent-dir "$@"
}
# The gate: the knowledge directory, then each guidelines file of the same
# repository at the same commit, as knowledge/.review/<name>-guidelines.md.
fetch_knowledge() {
  local dest="$agent_dir/knowledge" msg line n=0 base parent ref="$knowledge_ref" tmp
  [[ ! -e "$dest" ]] || fail "the agent directory already has a knowledge/ entry; the knowledge input writes it"
  local k=(--path "$knowledge_path" --dest /agent-out/dir/knowledge --repo "$knowledge_repo")
  [[ -n "$ref" ]] && k+=(--ref "$ref")
  if ! msg="$(fetch_dir "${k[@]}" 2>&1)"; then echo "$msg" >&2; fail "could not fetch knowledge $knowledge"; fi
  echo "$msg"
  if [[ -z "$ref" ]]; then
    [[ "$msg" =~ @([0-9a-f]{40}) ]] || fail "could not tell which commit the knowledge came from"
    ref="${BASH_REMATCH[1]}"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$ && ! "/$line/" =~ /\.\.?/ ]] || fail "invalid knowledge-guidelines path (a file in a directory of $knowledge_repo): $line"
    base="${line##*/}" parent="${line%/*}"
    [[ "$base" =~ ^[A-Za-z0-9._-]+-guidelines\.md$ ]] || fail "a knowledge-guidelines file must be named <name>-guidelines.md: $line"
    n=$((n + 1)) tmp="guidelines-$n"
    rm -rf "${work:?}/agent/$tmp"
    if ! msg="$(fetch_dir --path "$parent" --dest "/agent-out/$tmp" --repo "$knowledge_repo" --ref "$ref" 2>&1)"; then echo "$msg" >&2; fail "could not fetch $line from $knowledge_repo"; fi
    [[ -f "$work/agent/$tmp/$base" && ! -L "$work/agent/$tmp/$base" ]] || fail "$knowledge_repo@$ref has no file $line"
    mkdir -p "$dest/.review"
    [[ ! -e "$dest/.review/$base" ]] || fail "knowledge already has .review/$base"
    cp "$work/agent/$tmp/$base" "$dest/.review/$base"
    rm -rf "${work:?}/agent/$tmp"
    echo "guidelines $line from $knowledge_repo@$ref"
  done <<< "${RB_KNOWLEDGE_GUIDELINES:-}"
}
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
    # Run records for checks the gate completes itself (R-2 exit, A-6); the
    # workflow uploads them like the review job's.
    mkdir -p "$out/records"
    # The agent directory first (F-7): from the default branch or a pinned
    # commit, never the PR. GH_TOKEN reads it; no other secret is present.
    if [[ -n "$agent_path" ]]; then
      fetch=(fetch-agent-dir --path "$agent_path" --dest /agent-out/dir)
      agent_repo="${RB_AGENT_DIR_REPO:-}"
      if [[ -z "$agent_repo" ]]; then
        fetch+=(--repo "$repo")
      else
        [[ "$agent_repo" =~ ^([A-Za-z0-9-]+/[A-Za-z0-9._-]+)@([0-9a-f]{40})$ ]] || fail "agent-dir-repo must be owner/name@<40-hex commit SHA>: $agent_repo"
        fetch+=(--repo "${BASH_REMATCH[1]}" --ref "${BASH_REMATCH[2]}")
      fi
      rm -rf "$work/agent" && mkdir -p "$work/agent"
      fetch_dir "${fetch[@]:1}"
      if [[ -n "$knowledge" ]]; then fetch_knowledge; fi
    fi
    # Label and lifetime only when given: unset inputs leave settings.json's (F-7).
    args=(gate --repo "$repo" --name "$name" --records-dir /github/out/records)
    if [[ -n "${RB_AUTH_LABEL:-}" ]]; then args+=(--label "$RB_AUTH_LABEL"); fi
    if [[ -n "${RB_AUTH_LIFETIME:-}" ]]; then
      [[ "$RB_AUTH_LIFETIME" =~ ^(per-push|per-pr)$ ]] || fail "invalid auth-label-lifetime: $RB_AUTH_LIFETIME"
      args+=(--lifetime "$RB_AUTH_LIFETIME")
    fi
    use_agent_dir
    if [[ -n "${RB_PR:-}" ]]; then need_pr "$RB_PR"; args+=(--pr "$RB_PR"); fi
    # Waiting for CI (C-9): over settings.json; ci in .review/review-bot.yaml on the base branch replaces these.
    if [[ -n "${RB_CI_REQUIRE:-}" ]]; then
      (( ${#RB_CI_REQUIRE} <= 4000 )) || fail "ci-require is too long"
      [[ "$RB_CI_REQUIRE" != *[$'\x01'-$'\x09'$'\x0b'-$'\x1f'$'\x7f']* ]] || fail "ci-require has control characters"
      args+=(--ci-require "$RB_CI_REQUIRE")
    fi
    if [[ -n "${RB_CI_ON_FAILURE:-}" ]]; then
      [[ "$RB_CI_ON_FAILURE" =~ ^(skip|review)$ ]] || fail "invalid ci-on-failure: $RB_CI_ON_FAILURE"
      args+=(--ci-on-failure "$RB_CI_ON_FAILURE")
    fi
    if [[ -n "${RB_CI_TIMEOUT:-}" ]]; then
      [[ "$RB_CI_TIMEOUT" =~ ^[0-9]+(\.[0-9]+)?(s|m|h)?$ ]] || fail "invalid ci-timeout: $RB_CI_TIMEOUT"
      args+=(--ci-timeout "$RB_CI_TIMEOUT")
    fi
    if [[ "${RB_IGNORE_CI:-}" == true && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]]; then args+=(--ignore-ci); fi
    docker "${docker_args[@]}" "$image" "${args[@]}"
    # Pass on only well-formed outputs.
    while IFS= read -r line; do
      if [[ "$line" =~ ^[a-z-]+= && "$line" != *$'\r'* ]]; then echo "$line" >> "${GITHUB_OUTPUT:?}"; else fail "unexpected gate output line"; fi
    done < "$out/output"
    cat "$out/summary.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
    ;;

  setup)
    # Installs the agent directory's packages (F-7, C-4) in a job that holds
    # no secret: no GitHub token and no provider key enter this container,
    # and the job's own token has no permissions. Network is on (registries,
    # git hosts); lifecycle scripts are off (src/setup/). The read roots are
    # the review container's paths, so nothing is installed where the review
    # reads PR content.
    [[ -n "$agent_path" ]] || fail "setup needs agent-dir"
    [[ -d "$agent_dir" && ! -L "$agent_dir" ]] || fail "agent-dir is set but $agent_dir is missing (the gate job fetches it; the setup job downloads it)"
    out="$work/agent-out"
    rm -rf "$out" && mkdir -p "$out"
    docker run --rm --init --cap-drop ALL --security-opt no-new-privileges --read-only \
      --tmpfs /tmp:rw,nosuid,nodev,size=2g --pids-limit 1024 --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$agent_dir:/agent" \
      "$image" setup --agent-dir /agent --read-root /snapshot --read-root /runs
    # Pack it for the review job without network. Hard links become files
    # (the review job's extractor refuses them); symlinks stay symlinks.
    docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --read-only \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$agent_dir:/in/agent:ro" -v "$out:/out" --entrypoint tar \
      "$image" --create --gzip --file /out/agent-dir.tar.gz --hard-dereference --numeric-owner --owner=0 --group=0 --directory /in agent
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

    # 2. Review, as the pi command /review-bot (F-3): `launch` starts pi from
    # the image with -ne -e <pi-review>, --no-approve, --offline, stdin
    # closed and an empty working directory, and forwards SIGTERM to it. The
    # snapshot is mounted read-only; nothing in it is executed.
    args=(launch --pr "$repo#$RB_PR" --snapshot-dir /snapshot --runs-dir /runs --name "$name")
    role_lines --model '^(reviewer|verifier)=[^[:space:]]+$' "${RB_MODELS:-}"
    role_lines --thinking '^(reviewer|verifier)=(off|minimal|low|medium|high|xhigh|max)$' "${RB_THINKING:-}"
    role_lines --providers '^(reviewer|verifier)=[A-Za-z0-9._,-]+$' "${RB_PROVIDERS:-}"
    # What the gate knew about the wait for CI (A-6, C-9): one JSON line, checked again by the CLI.
    if [[ -n "${RB_WAITING:-}" ]]; then
      (( ${#RB_WAITING} <= 16384 )) || fail "waiting is too long"
      [[ "$RB_WAITING" == "{"*"}" && "$RB_WAITING" != *[$'\x01'-$'\x1f'$'\x7f']* ]] || fail "waiting must be one JSON object on one line"
      args+=(--waiting "$RB_WAITING")
    fi
    # Private repositories without contents: read / issues: read (C-4).
    if [[ "${RB_NO_HISTORY:-}" == true ]]; then args+=(--no-history); fi
    if [[ -n "${RB_MAX_COST:-}" ]]; then
      [[ "$RB_MAX_COST" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "invalid max-cost: $RB_MAX_COST"
      args+=(--max-cost "$RB_MAX_COST")
    fi
    docker_args+=(-e GH_TOKEN -v "$work/snapshot:/snapshot:ro" -v "$work/runs:/runs")
    use_installed_agent_dir
    installed="$work/agent-installed/agent"
    if [[ -n "$knowledge" ]]; then
      [[ -d "$installed/knowledge" && ! -L "$installed/knowledge" ]] || fail "knowledge is set but the agent directory has no knowledge/ (the gate fetches it)"
      args+=(--knowledge-dir /agent/knowledge)
    fi
    if [[ -n "$acp_config" ]]; then
      [[ -f "$installed/$acp_config" && ! -L "$installed/$acp_config" ]] || fail "acp-config is set but the agent directory has no file $acp_config"
      args+=(--acp-config "/agent/$acp_config")
    fi
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
    # The pipeline's run deadline sits a further two minutes inside that
    # (S-4 Limits, S-9): it aborts the running step, publishes what it has
    # labelled partial and completes the check as neutral before SIGTERM.
    # A ceiling, not a value: a lower runTimeoutSeconds in settings.json or
    # the base branch's .review/review-bot.yaml takes effect, a higher one
    # is cut to it (F-7).
    run_deadline=$(( seconds > 300 ? seconds - 120 : seconds * 3 / 4 ))
    args+=(--max-run-timeout "${run_deadline}s")
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
