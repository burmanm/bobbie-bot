/**
 * The operator's agent directory or `packages` cannot be used as configured
 * (F-7): fix the configuration, a retry does not help.
 */
export class SetupConfigError extends Error {
  override name = "SetupConfigError";
}

/** An installer failed or timed out during `setup`. A retry may help. */
export class PackageInstallError extends Error {
  override name = "PackageInstallError";
}
