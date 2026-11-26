/**
 * The snapshot artifact that the unprivileged `prepare` job hands to the
 * `review` job (C-4, S-1):
 *
 *   snapshot.tar.gz
 *     manifest.json   { version, repo, pr, baseSha, headSha, modcache }
 *     base/           base tree at baseSha (no .git)
 *     head/           head tree at headSha (no .git)
 *     modcache/       Go module cache for head's go.mod, when prepared
 *
 * `action/prepare.sh` writes it. The review job extracts it with the
 * validating extractor (`tar.ts`) and reads the trees as data only.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { SnapshotSide, SnapshotSource } from "../platform/index.ts";
import { unpackTarGz, type UnpackOptions, type UnpackStats } from "./tar.ts";

const SHA = Type.String({ pattern: "^[0-9a-f]{40}$" });

export const MODCACHE_STATUSES = ["ok", "failed", "skipped", "too-large"] as const;

export const SnapshotManifest = Type.Object(
  {
    version: Type.Literal(1),
    repo: Type.String({ pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$" }),
    pr: Type.Integer({ minimum: 1 }),
    baseSha: SHA,
    headSha: SHA,
    modcache: Type.Object({
      status: Type.Enum(MODCACHE_STATUSES),
      /** Why there is no module cache, for the log and the job summary. */
      detail: Type.Optional(Type.String()),
    }),
    createdAt: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type SnapshotManifest = Static<typeof SnapshotManifest>;

export const SNAPSHOT_TOP = ["manifest.json", "base", "head", "modcache"] as const;

export function readManifest(dir: string): SnapshotManifest {
  const file = join(dir, "manifest.json");
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Value.Check(SnapshotManifest, data)) {
    const errors = [...Value.Errors(SnapshotManifest, data)].slice(0, 3).map((e) => `${e.instancePath || "/"}: ${e.message}`);
    throw new Error(`invalid snapshot manifest ${file}: ${errors.join("; ")}`);
  }
  for (const side of ["base", "head"] as const) {
    if (!existsSync(join(dir, side))) throw new Error(`snapshot ${dir} has no ${side}/ tree`);
  }
  return data;
}

/** The module cache directory of a prepared snapshot, when it was prepared. */
export function preparedModcache(dir: string, manifest: SnapshotManifest): string | undefined {
  const m = join(dir, "modcache");
  return manifest.modcache.status === "ok" && existsSync(m) ? m : undefined;
}

/**
 * A `SnapshotSource` over a prepared, already extracted snapshot. It only
 * hands out the tree whose SHA the pipeline asks for: if the PR moved after
 * preparation, extraction fails and the run completes as *could not
 * complete*; the newer push's own run reviews the new head (S-9).
 */
export class PreparedSnapshots implements SnapshotSource {
  readonly kind = "prepared";
  readonly dir: string;
  readonly manifest: SnapshotManifest;

  constructor(dir: string) {
    this.dir = dir;
    this.manifest = readManifest(dir);
  }

  /** Checks that the snapshot is for this PR. */
  assertFor(repo: string, pr: number): void {
    if (this.manifest.repo.toLowerCase() !== repo.toLowerCase() || this.manifest.pr !== pr) {
      throw new Error(`snapshot ${this.dir} is for ${this.manifest.repo}#${this.manifest.pr}, not ${repo}#${pr}`);
    }
  }

  async extract(side: SnapshotSide, sha: string, dest: string): Promise<void> {
    const prepared = side === "head" ? this.manifest.headSha : this.manifest.baseSha;
    if (prepared !== sha) {
      throw new Error(
        `the prepared ${side} snapshot is ${prepared.slice(0, 7)} but the PR's ${side} is now ${sha.slice(0, 7)}: the PR changed after the snapshots were prepared`,
      );
    }
    mkdirSync(dest, { recursive: true });
    if (readdirSync(dest).length > 0) throw new Error(`snapshot destination ${dest} is not empty`);
    cpSync(join(this.dir, side), dest, { recursive: true, verbatimSymlinks: true });
  }
}

/** Extracts the artifact with the validating extractor and checks the manifest. */
export async function unpackSnapshot(
  archive: string,
  dest: string,
  o: Omit<UnpackOptions, "allowedTop"> = {},
): Promise<{ manifest: SnapshotManifest; stats: UnpackStats }> {
  const stats = await unpackTarGz(archive, dest, { ...o, allowedTop: SNAPSHOT_TOP, keepExecutable: false });
  const manifest = readManifest(dest);
  return { manifest, stats };
}
