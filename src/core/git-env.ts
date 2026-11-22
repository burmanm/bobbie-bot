/**
 * git's environment for every process that may run git near a snapshot
 * (C-3a). Pure: it changes only the object it is given.
 */

/**
 * Append `safe.bareRepository=explicit` to git's environment configuration
 * (C-3a), so git started inside an embedded bare repository of the PR refuses
 * it instead of running its `core.fsmonitor`. The last entry wins in git, so
 * it is appended unless it already is last; existing entries are kept.
 *
 * From then on `git -C <bare repository>` is refused in that environment:
 * name such a repository with `--git-dir`.
 */
export function requireExplicitBareRepository(env: NodeJS.ProcessEnv): void {
  const raw = env.GIT_CONFIG_COUNT || "0";
  if (!/^\d+$/.test(raw)) throw new Error(`GIT_CONFIG_COUNT is not a number: ${raw}`);
  const count = Number(raw);
  const key = "safe.bareRepository";
  const value = "explicit";
  if (count > 0 && env[`GIT_CONFIG_KEY_${count - 1}`] === key && env[`GIT_CONFIG_VALUE_${count - 1}`] === value) return;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}
