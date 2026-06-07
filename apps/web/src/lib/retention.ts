const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const MAX_ARTIFACT_RETENTION_DAYS = 365;
const SECONDS_PER_DAY = 24 * 60 * 60;

export type ArtifactRetentionStatus = {
  enabled: boolean;
  valid: boolean;
  days?: number;
  seconds?: number;
  configuredDays?: number;
  defaultDays: number;
  maxDays: number;
};

export function artifactRetentionStatus(): ArtifactRetentionStatus {
  const rawValue = process.env.PATCHBAY_ARTIFACT_RETENTION_DAYS?.trim();

  if (rawValue === undefined || rawValue === "") {
    return buildStatus(DEFAULT_ARTIFACT_RETENTION_DAYS, {
      valid: true
    });
  }

  const configuredDays = Number(rawValue);
  if (!Number.isFinite(configuredDays) || configuredDays < 0) {
    return buildStatus(DEFAULT_ARTIFACT_RETENTION_DAYS, {
      configuredDays,
      valid: false
    });
  }

  return buildStatus(Math.min(configuredDays, MAX_ARTIFACT_RETENTION_DAYS), {
    configuredDays,
    valid: true
  });
}

export function artifactRetentionCutoffMs(nowMs = Date.now()) {
  const status = artifactRetentionStatus();
  if (!status.enabled || status.seconds === undefined) {
    return undefined;
  }
  return nowMs - status.seconds * 1000;
}

function buildStatus(
  days: number,
  options: { configuredDays?: number; valid: boolean }
): ArtifactRetentionStatus {
  if (days === 0) {
    return {
      enabled: false,
      valid: options.valid,
      configuredDays: options.configuredDays,
      defaultDays: DEFAULT_ARTIFACT_RETENTION_DAYS,
      maxDays: MAX_ARTIFACT_RETENTION_DAYS
    };
  }

  const seconds = Math.max(1, Math.ceil(days * SECONDS_PER_DAY));
  return {
    enabled: true,
    valid: options.valid,
    days,
    seconds,
    configuredDays: options.configuredDays,
    defaultDays: DEFAULT_ARTIFACT_RETENTION_DAYS,
    maxDays: MAX_ARTIFACT_RETENTION_DAYS
  };
}
