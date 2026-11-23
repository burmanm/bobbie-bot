/**
 * The operator's agent directory or `packages` cannot be used as configured
 * (F-7): fix the configuration, a retry does not help.
 */
export class SetupConfigError extends Error {
  override name = "SetupConfigError";
}

/** `setup` was stopped (Ctrl-C, SIGTERM) and killed the installer that was running. */
export class SetupCancelledError extends Error {
  override name = "SetupCancelledError";
}

/** An installer failed or timed out during `setup`. A retry may help. */
export class PackageInstallError extends Error {
  override name = "PackageInstallError";
}
