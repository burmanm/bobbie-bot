/**
 * Installing and verifying the operator's pi packages (R-1a step 4, F-7).
 * `setupPackages` runs in the step without secrets, `verifyInstalled` in
 * the offline review. Loading them into sessions is not here.
 */
export { REFUSED_FILES } from "./agent-dir.ts";
export { PackageInstallError, SetupCancelledError, SetupConfigError } from "./errors.ts";
export type { CommandOptions, CommandResult, CommandRunner } from "./installer.ts";
export { setupPackages, type SetupOptions } from "./setup.ts";
export { type Package, type PackagesInput, validatePackages } from "./sources.ts";
export { type InstalledPackage, verifyInstalled } from "./verify.ts";
