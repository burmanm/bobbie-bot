# review-bot

Automated PR reviewer built on pi. The design is in `docs/plan/`; start at
`docs/plan/README.md`. Section IDs (P-, D-, A-, S-, C-, R-, …) are stable:
cite them in commits and code comments where a rule comes from the plan.

## Conventions

- TypeScript run directly by Node (type stripping, Node >= 22.19). No build
  step. Only erasable syntax: no `enum`, no `namespace`, no parameter
  properties. Relative imports use the `.ts` extension.
- `npm run typecheck` and `npm test` (node:test) must pass before a commit.
- Dependencies are pinned exactly and installed with
  `npm ci --ignore-scripts`. pi is pinned to 1.5.2 (F-6); upgrading it is a
  separate change that runs the isolation regression test (C-3a).
- Schemas use `typebox` (the version pi uses).
- Module boundaries follow A-2: `core` imports nothing from pi or GitHub.
- Tests never use the network or a real model. Model steps are tested with
  pi's scripted ("faux") provider from `@earendil-works/pi-ai`.
- Never write an API key to a file, a log, or a test fixture.
- `spike/` is the ignored, throwaway R-0 spike. Read it for reference
  (`spike/spike.ts`, `spike/extension/`), do not import from it.
