# Review guidance — widget

## What failure looks like here

A caller of `store` panics or silently loses a value.

## Focus on

1. Every exported method must be safe to call in any order after `New`.

## Don't flag

- Style the linter enforces.

## Needs a human (a marker, not a finding)

Changed or removed assertions in existing tests. List them on one line at the end of the summary.

## Skip these paths

- `go.sum`
- `**/zz_generated.go`

## Limits

- At most 1 Nit per review.
