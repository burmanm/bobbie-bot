/**
 * A PR stored as files, for tests and offline dry runs:
 *
 *   pr.json              PullRequestInfo
 *   pr.diff              the PR diff (base...head)
 *   comments.json        PrComment[] (optional; default none)
 *   compare/<sha>.diff   diff of the commits since <sha> (optional; incremental runs)
 *   head/, base/         the two trees
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrReader } from "./dry-run.ts";
import { DirectorySnapshots } from "./snapshot.ts";
import type { PrComment, PullRequestInfo } from "./types.ts";

export class FixturePrReader implements PrReader {
  readonly kind = "fixture";
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    return JSON.parse(readFileSync(join(this.dir, "pr.json"), "utf8")) as PullRequestInfo;
  }

  async getDiff(sinceSha?: string): Promise<string | undefined> {
    if (sinceSha === undefined) return readFileSync(join(this.dir, "pr.diff"), "utf8");
    if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) return undefined;
    const file = join(this.dir, "compare", `${sinceSha}.diff`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  async listComments(): Promise<PrComment[]> {
    const file = join(this.dir, "comments.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PrComment[]) : [];
  }

  snapshots(): DirectorySnapshots {
    return new DirectorySnapshots({ head: join(this.dir, "head"), base: join(this.dir, "base") });
  }
}
