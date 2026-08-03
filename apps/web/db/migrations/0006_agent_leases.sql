ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

UPDATE agents
SET lease_expires_at = COALESCE(lease_expires_at, now() + interval '120 seconds');

ALTER TABLE agents
  ALTER COLUMN lease_expires_at SET DEFAULT now() + interval '120 seconds',
  ALTER COLUMN lease_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agents_lease_expires_at
  ON agents(lease_expires_at)
  WHERE revoked_at IS NULL;
