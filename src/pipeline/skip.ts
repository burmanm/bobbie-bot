/**
 * Skip conditions (S-1): the run completes the check as *skipped*, with a
 * reason, and writes a run record. All configurable from workflow inputs
 * and `.review/review-bot.yaml` (`skip:`):
 *
 * | Condition | Default | Kind |
 * |---|---|---|
 * | No root `REVIEW.md` on the base branch (A-5) | always | `not-onboarded` |
 * | Draft PR | on (`draft: true`) | `draft` |
 * | Opt-out label | `ai-review/skip` (`optOutLabels`) | `opt-out` |
 * | Round-cap label, set by the review-process workflow (RP §4.2) | `round-cap` (`roundCapLabels`) | `round-cap` |
 * | Any other configured label | none (`labels`) | `label` |
 * | `deps`-labelled PR that changes only dependency files | `deps` (`dependencies.labels`) and common manifests and lock files (`dependencies.paths`) | `deps-only` |
 * | This head was already reviewed (C-1, idempotent) | always | `already-reviewed` |
 *
 * Labels match case-insensitively, as GitHub's do. A `deps`-labelled PR
 * that also changes anything else is reviewed in full; the label alone is
 * not trusted to describe the change. Dependency paths use the skip-glob
 * dialect (core/skip.ts): a pattern without `/` matches the file name at
 * any depth.
 */
import { type FilePatch, globToRegExp } from "../core/index.ts";
import type { PullRequestInfo } from "../platform/index.ts";

export const SKIP_KINDS = ["not-onboarded", "draft", "opt-out", "round-cap", "label", "deps-only", "already-reviewed"] as const;
export type SkipKind = (typeof SKIP_KINDS)[number];

export interface SkipDecision {
  kind: SkipKind;
  reason: string;
}

export interface SkipConfig {
  draft: boolean;
  /** Further labels that skip the review. */
  labels: string[];
  optOutLabels: string[];
  roundCapLabels: string[];
  dependencies: { labels: string[]; paths: string[] };
}

/** Manifests, lock files and vendored trees that a dependency-update PR touches. */
export const DEFAULT_DEPENDENCY_PATHS = [
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "vendor/**",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.toml",
  "Cargo.lock",
  "requirements*.txt",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
];

export const DEFAULT_SKIP: SkipConfig = {
  draft: true,
  labels: [],
  optOutLabels: ["ai-review/skip"],
  roundCapLabels: ["round-cap"],
  dependencies: { labels: ["deps"], paths: DEFAULT_DEPENDENCY_PATHS },
};

export function cloneSkipConfig(c: SkipConfig): SkipConfig {
  return {
    draft: c.draft,
    labels: [...c.labels],
    optOutLabels: [...c.optOutLabels],
    roundCapLabels: [...c.roundCapLabels],
    dependencies: { labels: [...c.dependencies.labels], paths: [...c.dependencies.paths] },
  };
}

function labelIn(pr: PullRequestInfo, wanted: readonly string[]): string | undefined {
  const set = new Set(wanted.map((l) => l.toLowerCase()));
  return pr.labels.find((l) => set.has(l.toLowerCase()));
}

const short = (sha: string) => sha.slice(0, 7);

/** Conditions decidable from the PR metadata alone, in the order of the table above. */
export function skipBeforeDiff(
  pr: PullRequestInfo,
  config: SkipConfig,
  facts: { hasReviewMd: boolean; lastReviewedSha?: string | undefined },
): SkipDecision | undefined {
  if (!facts.hasReviewMd) {
    return { kind: "not-onboarded", reason: "the repository has no REVIEW.md on the base branch, so it is not onboarded for automated review (A-5)" };
  }
  if (pr.draft && config.draft) return { kind: "draft", reason: "the pull request is a draft" };
  const optOut = labelIn(pr, config.optOutLabels);
  if (optOut !== undefined) return { kind: "opt-out", reason: `the pull request has the opt-out label "${optOut}"` };
  const cap = labelIn(pr, config.roundCapLabels);
  if (cap !== undefined) {
    return { kind: "round-cap", reason: `the pull request has the label "${cap}": the review round cap was reached, so it goes to human reviewers` };
  }
  const other = labelIn(pr, config.labels);
  if (other !== undefined) return { kind: "label", reason: `the pull request has the label "${other}"` };
  if (facts.lastReviewedSha === pr.headSha) {
    return { kind: "already-reviewed", reason: `head ${short(pr.headSha)} was already reviewed (run is idempotent, C-1)` };
  }
  return undefined;
}

/**
 * The `deps` condition, once the PR's whole diff is known: labelled, and
 * every changed path (both sides of a rename) is a dependency file.
 * Returns undefined when not labelled, when the diff is empty, or when
 * anything else changes.
 */
export function dependencyOnlySkip(pr: PullRequestInfo, files: readonly FilePatch[], config: SkipConfig): SkipDecision | undefined {
  const label = labelIn(pr, config.dependencies.labels);
  if (label === undefined || files.length === 0 || config.dependencies.paths.length === 0) return undefined;
  const res = config.dependencies.paths.map((g) => globToRegExp(g));
  const paths = files.flatMap((f) => [f.newPath, f.oldPath]).filter((p): p is string => p !== undefined);
  if (!paths.every((p) => res.some((re) => re.test(p)))) return undefined;
  const names = [...new Set(files.map((f) => f.path))].slice(0, 5);
  const more = files.length > names.length ? `, and ${files.length - names.length} more` : "";
  return {
    kind: "deps-only",
    reason: `the pull request has the label "${label}" and changes only dependency files (${names.join(", ")}${more})`,
  };
}

/** Why a `deps`-labelled PR is reviewed anyway, for the log; undefined when not labelled. */
export function dependencyLabelNote(pr: PullRequestInfo, files: readonly FilePatch[], config: SkipConfig): string | undefined {
  const label = labelIn(pr, config.dependencies.labels);
  if (label === undefined) return undefined;
  const res = config.dependencies.paths.map((g) => globToRegExp(g));
  const other = files.map((f) => f.path).filter((p) => !res.some((re) => re.test(p)));
  return other.length === 0 ? undefined : `label "${label}" present, but the PR also changes ${other.slice(0, 3).join(", ")}${other.length > 3 ? ", ..." : ""}; reviewed`;
}
