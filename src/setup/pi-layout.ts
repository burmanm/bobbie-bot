/**
 * Where pi 1.5.2 looks for an installed package (F-7).
 *
 * pi does not export its source parser or install layout, and its public
 * lookup spawns `npm root -g` when an npm package is missing. Copying them
 * would risk verifying one directory while pi loads another, so this calls
 * the package manager's own methods that only compute. They are internal:
 * the pin (F-6) and this module's tests cover an upgrade.
 */
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export type PiSource =
  | { type: "npm"; spec: string; name: string; version?: string }
  | { type: "git"; repo: string; host: string; path: string; ref?: string }
  | { type: "local"; path: string };

interface Internals {
  parseSource(source: string): PiSource;
  getManagedNpmInstallPath(source: PiSource, scope: "user"): string;
  getGitInstallPath(source: PiSource, scope: "user"): string;
  resolvePathFromBase(path: string, base: string): string;
}

export interface PiLayout {
  parse(source: string): PiSource;
  installPath(source: PiSource): string;
}

export function createPiLayout(agentDir: string): PiLayout {
  const manager = new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  }) as unknown as Internals;
  return {
    parse: (source) => manager.parseSource(source),
    installPath(source) {
      switch (source.type) {
        case "npm":
          return manager.getManagedNpmInstallPath(source, "user");
        case "git":
          return manager.getGitInstallPath(source, "user");
        case "local":
          return manager.resolvePathFromBase(source.path, agentDir);
      }
    },
  };
}
