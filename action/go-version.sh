#!/usr/bin/env bash
# The Go version for the prepare job's `go mod download` (C-4). With
# RB_GO_VERSION "go.mod" (the default), it is read from the head commit's
# go.mod in the first of RB_GO_MODULES: the `toolchain` line, else the `go`
# line. With GOTOOLCHAIN=local an older Go than that fails, and the review
# then runs without a module cache.
#
# The value comes from the PR's head, so it is held to a strict format and
# only picks which official Go release actions/setup-go installs, in a job
# that holds no secret. Anything else falls back to "stable".
#
# Environment: RB_GO_VERSION, RB_REPO, RB_HEAD_SHA, RB_GO_MODULES (default
# "."), GH_TOKEN (contents:read), GITHUB_OUTPUT. Writes version=<v>.
set -euo pipefail
set -f

fail() { echo "go-version: $*" >&2; exit 1; }
out() { echo "version=$1" >> "${GITHUB_OUTPUT:?}"; echo "go-version: $1${2:+ ($2)}" >&2; }

want="${RB_GO_VERSION:-go.mod}"
if [[ "$want" != go.mod ]]; then
  out "$want" "given"
  exit 0
fi
[[ "${RB_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "RB_REPO must be owner/name"
[[ "${RB_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "RB_HEAD_SHA must be a 40-hex SHA"
read -r dir _ <<< "${RB_GO_MODULES:-.}"
dir="${dir:-.}"
[[ "$dir" =~ ^[A-Za-z0-9._/-]+$ && "$dir" != /* && "$dir" != *..* ]] || fail "RB_GO_MODULES entries must be relative paths without '..': $dir"
dir="${dir#./}"
dir="${dir%/}"
path="go.mod"
[[ "$dir" != "." && -n "$dir" ]] && path="$dir/go.mod"

if ! mod="$(gh api -H 'Accept: application/vnd.github.raw+json' "repos/$RB_REPO/contents/$path?ref=$RB_HEAD_SHA" 2>/dev/null)"; then
  out stable "no $path at ${RB_HEAD_SHA:0:7}"
  exit 0
fi
version="$(printf '%s\n' "$mod" | sed -n -E 's/^toolchain[[:space:]]+go([^[:space:]]+)[[:space:]]*(\/\/.*)?$/\1/p' | head -n 1)"
from="toolchain line"
if [[ -z "$version" ]]; then
  version="$(printf '%s\n' "$mod" | sed -n -E 's/^go[[:space:]]+([^[:space:]]+)[[:space:]]*(\/\/.*)?$/\1/p' | head -n 1)"
  from="go line"
fi
if [[ ! "$version" =~ ^1\.[0-9]{1,3}(\.[0-9]{1,3})?((rc|beta)[0-9]{1,2})?$ ]]; then
  out stable "no usable go or toolchain line in $path"
  exit 0
fi
out "$version" "$from of $path"
