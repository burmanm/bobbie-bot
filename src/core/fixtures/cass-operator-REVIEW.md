<!-- Excerpt of review-process pilot/cass-operator/REVIEW.md (2026-11), copied for tests. -->
# Review guidance — cass-operator

<!-- Draft harvested from past maintainer review comments. Owner to correct. Shared rules live in shared/go-operator-guidelines.md; this file covers only what is specific to this repo. -->

Owners: @k8ssandra/maintainers

## What failure looks like here


## Needs a human (a marker, not a finding)

New `//nolint` directives and changed or removed assertions in existing tests need human approval (shared guidelines §8.5–8.6) *(CI detector, T17)*. Don't report them as findings. List them on one line at the end of the summary: `Needs human: <what> in <file:line, ...>. Explained in the description: yes/no.`

Report an Important finding only when the description doesn't explain the change, or the explanation doesn't match the diff.

## Intentional trade-offs

If the PR description states a trade-off or a known limitation, don't flag it. Raise it only if it leads to one of the failures under "What failure looks like here". Then ask the author about it as a question rather than reporting it as a finding.

## Don't flag

- Style the linter enforces (`.golangci.yml`).
- Comments the shared guidelines say to delete. Flag that as a single Nit per PR, not one finding per comment.
- The wording of error and log messages that use the terms users know. For example, "the Cassandra version does not support it" is fine when the exact cause is the Management API image.
- What CI already checks: the linked issue, and generated files (`make manifests generate` must leave no diff).

## Skip these paths

- `**/zz_generated.deepcopy.go`
- `config/crd/bases/**`
- `go.sum`
- `tests/testdata/**`, unless the PR's purpose is test data

## Limits

- At most 3 Nits per review.
- Tag each finding Important, Nit or Pre-existing.
- A transient error that surfaces as a Warning event or an error log but converges is a Nit, unless it loops.
- A rare trigger that ends in something irreversible, such as deleted data or a node removed too early, is Important. Say that the trigger is rare and what it needs.
- **Pre-existing** findings don't count toward the limits.
  - List them in the summary only, not as inline comments.
  - Give each one a one-line proposed `tech-debt` issue. Check first whether an issue already exists. If you can't search the tracker, write "not checked".
- Don't repeat findings already posted on this PR. If you can't see the PR discussion, say so once and review as if there were none.
- If the same problem appears in several places, report it once and list every location.

## Summary format

Start with a count, for example "N important, M nits, K pre-existing." If there is nothing to fix, say so plainly. Put questions for the author, such as unverifiable Cassandra behaviour or a trade-off to confirm, under "Questions for the author". They don't count as findings. End with the `Needs human:` line when it applies.
