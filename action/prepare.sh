#!/usr/bin/env bash
# review-bot `prepare` job (C-4): fetch the base and head trees, run the Go
# preparation step, and pack everything into one archive for the review job.
#
# Runs with NO secrets and a `contents: read` token. Nothing from the PR is
# executed. The only PR-controlled input that reaches a tool acting on it is
# the head's go.mod/go.sum, read by `go mod download`, hardened below.
#
# Environment (all required unless a default is given):
#   RB_REPO            owner/name
#   RB_PR              PR number
#   RB_BASE_SHA        40-hex base SHA (from the gate)
#   RB_HEAD_SHA        40-hex head SHA (from the gate; what was authorized)
#   RB_WORK            empty working directory
#   GH_TOKEN           contents:read token, used only by `gh api` for the tarballs
#   RB_GO_MODULES      directories in the head holding a go.mod (default ".")
#   RB_GOPROXY         module proxy (default https://proxy.golang.org)
#   RB_GO_TIMEOUT      seconds for each `go mod download` (default 600)
#   RB_MODCACHE_MAX_MB size cap for the module cache (default 3072)
#
# Output: $RB_WORK/out/snapshot.tar.gz holding manifest.json, base/, head/
# and, when preparation succeeded, modcache/.
set -euo pipefail
set -f # no globbing of RB_GO_MODULES words
umask 022
export COPYFILE_DISABLE=1 # no AppleDouble files when run on macOS (tests)

fail() { echo "prepare: $*" >&2; exit 1; }
log() { echo "prepare: $*" >&2; }
# Text from the PR (go's errors about its go.mod) is logged with workflow
# commands stopped under a fresh random token: the runner acts on the legacy
# `##[name]` anywhere in a line (H-55, C-3; see untrusted() in run.sh).
log_untrusted() {
  local token
  token="rb$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$token" =~ ^rb[0-9a-f]{32}$ ]] || fail "no random stop token"
  echo "::stop-commands::$token" >&2
  log "$*"
  echo "::$token::" >&2
}

[[ "${RB_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "RB_REPO must be owner/name"
[[ "${RB_PR:-}" =~ ^[1-9][0-9]*$ ]] || fail "RB_PR must be a PR number"
[[ "${RB_BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "RB_BASE_SHA must be a 40-hex SHA"
[[ "${RB_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "RB_HEAD_SHA must be a 40-hex SHA"
[[ -n "${RB_WORK:-}" ]] || fail "RB_WORK is required"
modules="${RB_GO_MODULES:-.}"
goproxy="${RB_GOPROXY:-https://proxy.golang.org}"
go_timeout="${RB_GO_TIMEOUT:-600}"
max_mb="${RB_MODCACHE_MAX_MB:-3072}"
[[ "$go_timeout" =~ ^[0-9]+$ ]] || fail "RB_GO_TIMEOUT must be seconds"
[[ "$max_mb" =~ ^[0-9]+$ ]] || fail "RB_MODCACHE_MAX_MB must be a number"
for dir in $modules; do
  [[ "$dir" =~ ^[A-Za-z0-9._/-]+$ && "$dir" != /* && "$dir" != *..* ]] || fail "RB_GO_MODULES entries must be relative paths without '..': $dir"
done
# One proxy URL, no ",direct" and no "off" lists: direct mode runs VCS tools.
[[ "$goproxy" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || fail "RB_GOPROXY must be a single https:// URL"

mkdir -p "$RB_WORK"
work="$(cd "$RB_WORK" && pwd -P)"
stage="$work/stage"
mkdir -p "$work/download" "$stage/base" "$stage/head" "$work/out"

# ---- trees ----------------------------------------------------------------
# GitHub's tarball of a commit: a plain tree, no .git, wrapped in one
# top-level directory. The fork's head commit is reachable from the base
# repository (refs/pull/N/head), so the base repository's token suffices.
for side in base head; do
  if [[ "$side" == base ]]; then sha="$RB_BASE_SHA"; else sha="$RB_HEAD_SHA"; fi
  gh api "repos/$RB_REPO/tarball/$sha" > "$work/download/$side.tar.gz" || fail "could not download the $side tree $sha"
  tar -xzf "$work/download/$side.tar.gz" -C "$stage/$side" --strip-components=1 --no-same-owner || fail "could not extract the $side tree"
  rm -f "$work/download/$side.tar.gz"
  log "$side tree ${sha:0:7} extracted"
done

# ---- Go preparation (head's go.mod) ----------------------------------------
# What `go mod download` does with an attacker-controlled go.mod: it fetches
# the listed module versions as zip files from the proxy and checks them
# against the checksum database. It does not build or run anything. The
# settings below keep it to exactly that:
#   GOPROXY=<one proxy>   no direct mode, so no git/hg/svn/bzr is ever run
#   GOVCS=*:off           belt and braces for the same
#   GOSUMDB=sum.golang.org, GONOSUMDB/GONOSUMCHECK/GOPRIVATE/GONOPROXY/GOINSECURE empty
#                         every module is checked against the public sum database
#   GOTOOLCHAIN=local     a `toolchain`/`go` line cannot download and run another Go
#   GOFLAGS=-mod=readonly go.mod/go.sum are never rewritten (and this runs on a copy)
#   GOWORK=off            a go.work in the PR is ignored
#   GOAUTH=off, empty HOME  no .netrc or credential helper is consulted
#   env -i                the GitHub token is not in go's environment
# Residual risk: the PR chooses which public module versions are fetched
# (bandwidth, disk; capped by the timeout and size cap below), and can make
# the step fail, in which case the review runs without a module cache.
modcache_status="skipped"
modcache_detail="no go.mod in the head tree"
modcache="$stage/modcache"
if command -v go >/dev/null 2>&1; then
  gomod_found=0
  for dir in $modules; do
    [[ -f "$stage/head/$dir/go.mod" ]] && gomod_found=1
  done
  if [[ "$gomod_found" == 1 ]]; then
    scratch="$work/gomod-scratch"
    rm -rf "$scratch"
    cp -R "$stage/head" "$scratch"
    mkdir -p "$work/gohome" "$work/gopath" "$work/gocache" "$modcache"
    timeout_cmd=()
    if command -v timeout >/dev/null 2>&1; then timeout_cmd=(timeout --kill-after=10 "$go_timeout"); fi
    modcache_status="ok"
    modcache_detail=""
    for dir in $modules; do
      [[ -f "$scratch/$dir/go.mod" ]] || continue
      log "go mod download in ${dir}"
      if ! (cd "$scratch/$dir" && env -i \
          PATH="$PATH" HOME="$work/gohome" \
          GOMODCACHE="$modcache" GOPATH="$work/gopath" GOCACHE="$work/gocache" \
          GOPROXY="$goproxy" GOSUMDB=sum.golang.org \
          GONOSUMDB= GONOSUMCHECK= GONOPROXY= GOPRIVATE= GOINSECURE= \
          GOVCS='*:off' GOTOOLCHAIN=local GOFLAGS='-mod=readonly -modcacherw' \
          GOWORK=off GOAUTH=off GOENV=off GOTELEMETRY=off CGO_ENABLED=0 \
          ${timeout_cmd[@]+"${timeout_cmd[@]}"} go mod download >"$work/go-mod-download.log" 2>&1); then
        modcache_status="failed"
        modcache_detail="go mod download failed in ${dir}: $(tail -n 3 "$work/go-mod-download.log" | tr -d '\000-\037"\\' | cut -c1-300)"
        log_untrusted "$modcache_detail"
        break
      fi
    done
    rm -rf "$scratch"
    # The zip downloads duplicate the extracted sources the reviewer reads.
    rm -rf "$modcache/cache"
    if [[ "$modcache_status" == ok ]]; then
      size_mb=$(du -sm "$modcache" | cut -f1)
      if (( size_mb > max_mb )); then
        modcache_status="too-large"
        modcache_detail="module cache is ${size_mb} MB, over the ${max_mb} MB cap"
        log "$modcache_detail"
      else
        log "module cache ${size_mb} MB"
      fi
    fi
  fi
else
  modcache_detail="go is not installed in the prepare job"
fi
if [[ "$modcache_status" != ok ]]; then
  chmod -R u+w "$modcache" 2>/dev/null || true
  rm -rf "$modcache"
fi

# ---- manifest and archive ---------------------------------------------------
# All values were validated above; the detail has quotes and control
# characters removed.
printf '{"version":1,"repo":"%s","pr":%s,"baseSha":"%s","headSha":"%s","modcache":{"status":"%s","detail":"%s"},"createdAt":"%s"}\n' \
  "$RB_REPO" "$RB_PR" "$RB_BASE_SHA" "$RB_HEAD_SHA" "$modcache_status" "$modcache_detail" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$stage/manifest.json"
members=(manifest.json base head)
[[ -d "$modcache" ]] && members+=(modcache)
tar -czf "$work/out/snapshot.tar.gz" -C "$stage" "${members[@]}"
log "snapshot $(du -h "$work/out/snapshot.tar.gz" | cut -f1) at $work/out/snapshot.tar.gz (module cache: $modcache_status)"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  # Go's error text comes from the PR: one code span it cannot close (H-51).
  shown_detail="${modcache_detail//\`/}"
  {
    echo "### review-bot prepare"
    echo
    echo "Base \`${RB_BASE_SHA:0:7}\`, head \`${RB_HEAD_SHA:0:7}\`. Module cache: **$modcache_status**${shown_detail:+ (\`$shown_detail\`)}."
  } >> "$GITHUB_STEP_SUMMARY"
fi
