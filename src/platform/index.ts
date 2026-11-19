/** Public surface of `platform` (A-2). Imports only `core` types. */
export type * from "./types.ts";
export { DryRunPlatform, type CheckRunRecord, type DryRunOutput, type PrReader } from "./dry-run.ts";
export { FixturePrReader } from "./fixture.ts";
export { GhPrReader, parsePrRef } from "./github-read.ts";
export { foldInlineComments, GitHubPlatform, type GitHubPlatformOptions, type GitHubReport, SupersededError } from "./github.ts";
export {
  assertInstallationToken,
  type FetchLike,
  GitHubApiError,
  GitHubClient,
  type GitHubClientOptions,
  gitHubClientFromEnv,
  GraphQLError,
  RateLimitError,
  type RetryOptions,
} from "./github-client.ts";
export {
  CHECK_NAME_RE,
  type CheckRunRef,
  type CompleteCheckAction,
  type CompleteCheckOptions,
  completeCheckRun,
  findCheckRun,
  openCheckRun,
} from "./github-checks.ts";
export { failureMarker, hasFailureMarker, isOwnFailureComment, isOwnFindingRoot } from "./github-markers.ts";
export {
  assertIsolatedLocation,
  CONTEXT_NAMES,
  defaultExec,
  defaultModcache,
  DirectorySnapshots,
  type Exec,
  GhTarballSnapshots,
  GitArchiveSnapshots,
  type SnapshotSide,
  type SnapshotSource,
} from "./snapshot.ts";
