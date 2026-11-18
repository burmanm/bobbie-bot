<!-- Excerpt of review-process 04-templates.md section 3 (REVIEW.md template), copied for tests. -->
# Review guidance for <repo / area>

Owners: <team or people>

<!-- Judgement only. If a rule here can be checked by a script, write the check and delete the line. -->

## What failure looks like here
<!-- One or two lines. e.g. "Config: it misroutes traffic." "Docs: it lies." "Billing: it charges the wrong amount." -->

## Focus on
- <the 3–6 things that actually cause bugs in this code>
- **Mechanical changes are behaviour changes.** Lint rewrites, deprecation replacements and refactors need the author to state that the change is equivalent. Check each rewritten conditional on its own.
- **Fix the class, not the symptom.** For a bug fix, ask what else on the same code path has the same property.

## Don't flag
- Style issues the linter already enforces
- Anything a CI check already enforces (changelog fragment, generated files, linked issue)
- <patterns that look wrong but are intentional, with a short why>
- Trade-offs the PR description states, unless they lead to a failure under "What failure looks like here". Then ask, don't report a finding

## Needs a human (a marker, not a finding)
New `//nolint` directives and changed or removed assertions in existing tests need human approval even when correct.
List them on one line at the end of the summary: `Needs human: <what> in <file:line>. Explained in the description: yes/no.`
Report a finding only when the description doesn't explain the change.

## Skip these paths
- `generated/**`
- `vendor/**`
- `**/fixtures/**`

## Evidence
- Every finding must cite a file and line, and explain the concrete failure: what breaks, when, and how often the trigger has to happen. No guesses based on names alone.
- Trace every function a mechanism names before reporting it. Say what was traced and what was assumed.
- A finding, or the dismissal of one, that depends on library behaviour cites the library source at the version the repo pins (Go: `$(go env GOMODCACHE)/<module>@<version>/<path>:<line>`), or a small probe.
- Conclusions from subagents are claims to verify, not findings.

## Limits
- At most <3> nits per review.
- Tag each finding: Important / Nit / Pre-existing.
- Pre-existing findings don't count toward the limits. List them in the summary only, each with a one-line proposed `tech-debt` issue.
- Don't repeat findings already posted on this PR.
- If a bug pattern appears more than once, flag the pattern and list all instances.

## Summary format
Start with a count: "N important, M nits, K pre-existing."
If there is nothing to fix, say so plainly.
