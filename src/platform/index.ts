/** Public surface of `platform` (A-2). Imports only `core` types. */
export type * from "./types.ts";
export { DryRunPlatform, type CheckRunRecord, type DryRunOutput, type PrReader } from "./dry-run.ts";
export { FixturePrReader } from "./fixture.ts";
export { GhPrReader, parsePrRef } from "./github-read.ts";
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
