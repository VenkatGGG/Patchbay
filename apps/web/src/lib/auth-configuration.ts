export type AuthSecretSetting =
  | "PATCHBAY_ENROLLMENT_SECRET"
  | "PATCHBAY_AGENT_AUTH_SECRET";

export class AuthConfigurationError extends Error {
  readonly code = "AUTH_CONFIGURATION_ERROR";
  readonly setting: AuthSecretSetting;

  constructor(setting: AuthSecretSetting) {
    super(`${setting} must be explicitly configured`);
    this.name = "AuthConfigurationError";
    this.setting = setting;
  }
}

export function isAuthConfigurationError(
  error: unknown
): error is AuthConfigurationError {
  return (
    error instanceof AuthConfigurationError ||
    (error instanceof Error &&
      error.name === "AuthConfigurationError" &&
      "code" in error &&
      error.code === "AUTH_CONFIGURATION_ERROR")
  );
}

export function authConfigurationFailure(error: unknown) {
  if (!isAuthConfigurationError(error)) {
    return undefined;
  }

  return {
    status: 503,
    body: {
      error: "Authentication service is not configured",
      code: "AUTH_CONFIGURATION_ERROR"
    }
  } as const;
}
