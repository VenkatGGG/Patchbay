CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'any',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  capability_packs JSONB NOT NULL DEFAULT '[]'::jsonb,
  tailscale JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '120 seconds',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(environment_id, name)
);

CREATE TABLE IF NOT EXISTS enrollment_invitations (
  token_hash TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read_only',
  status TEXT NOT NULL,
  allowed_capabilities TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investigation_nodes (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  capability TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  task_id TEXT REFERENCES session_tasks(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(investigation_id, node_key)
);

ALTER TABLE session_tasks
  ADD COLUMN IF NOT EXISTS investigation_node_id TEXT
    REFERENCES investigation_nodes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  idempotency_key TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS syntheses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_environment_id ON agents(environment_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_invitations_environment ON enrollment_invitations(environment_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_environment_id ON sessions(environment_id);
CREATE INDEX IF NOT EXISTS idx_investigations_session_id ON investigations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_investigation_nodes_investigation_id ON investigation_nodes(investigation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_tasks_session_id ON session_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_agent_status ON session_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_session_tasks_queued_capability
  ON session_tasks(capability, created_at)
  WHERE status = 'queued' AND agent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_events_session_id ON task_events(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_idempotency_key
  ON task_events(task_id, agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target);

INSERT INTO environments (id, name, provider)
VALUES ('env_local', 'Local incident lab', 'any')
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_log (id, action, actor, target, metadata)
VALUES (
  'aud_seed_env_local',
  'environment.seeded',
  'system',
  'env_local',
  '{"provider":"any"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_environments_provider'
      AND conrelid = 'environments'::regclass
  ) THEN
    ALTER TABLE environments
      ADD CONSTRAINT chk_environments_provider
      CHECK (provider IN ('any', 'aws', 'gcp', 'kubernetes', 'vm', 'docker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_status'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_status
      CHECK (status IN ('online', 'idle', 'offline'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_capabilities'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_capabilities
      CHECK (
        capabilities <@ ARRAY[
          'workload.discover',
          'cloud.metadata',
          'system.info',
          'process.list',
          'disk.usage',
          'network.connections',
          'logs.search',
          'docker.containers',
          'kubernetes.resources'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_tailscale_object'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_tailscale_object
      CHECK (jsonb_typeof(tailscale) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_capability_packs_array'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_capability_packs_array
      CHECK (jsonb_typeof(capability_packs) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_sessions_mode'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT chk_sessions_mode
      CHECK (mode = 'read_only');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_sessions_status'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT chk_sessions_status
      CHECK (status IN ('active', 'expired', 'closed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_sessions_allowed_capabilities'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT chk_sessions_allowed_capabilities
      CHECK (
        allowed_capabilities <@ ARRAY[
          'workload.discover',
          'cloud.metadata',
          'system.info',
          'process.list',
          'disk.usage',
          'network.connections',
          'logs.search',
          'docker.containers',
          'kubernetes.resources'
        ]::text[]
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_investigations_status'
      AND conrelid = 'investigations'::regclass
  ) THEN
    ALTER TABLE investigations
      ADD CONSTRAINT chk_investigations_status
      CHECK (status IN ('planned', 'running', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_investigation_nodes_capability'
      AND conrelid = 'investigation_nodes'::regclass
  ) THEN
    ALTER TABLE investigation_nodes
      ADD CONSTRAINT chk_investigation_nodes_capability
      CHECK (
        capability IN (
          'workload.discover',
          'cloud.metadata',
          'system.info',
          'process.list',
          'disk.usage',
          'network.connections',
          'logs.search',
          'docker.containers',
          'kubernetes.resources'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_investigation_nodes_status'
      AND conrelid = 'investigation_nodes'::regclass
  ) THEN
    ALTER TABLE investigation_nodes
      ADD CONSTRAINT chk_investigation_nodes_status
      CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'blocked'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_session_tasks_capability'
      AND conrelid = 'session_tasks'::regclass
  ) THEN
    ALTER TABLE session_tasks
      ADD CONSTRAINT chk_session_tasks_capability
      CHECK (
        capability IN (
          'workload.discover',
          'cloud.metadata',
          'system.info',
          'process.list',
          'disk.usage',
          'network.connections',
          'logs.search',
          'docker.containers',
          'kubernetes.resources'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_session_tasks_status'
      AND conrelid = 'session_tasks'::regclass
  ) THEN
    ALTER TABLE session_tasks
      ADD CONSTRAINT chk_session_tasks_status
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'denied'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_task_events_level'
      AND conrelid = 'task_events'::regclass
  ) THEN
    ALTER TABLE task_events
      ADD CONSTRAINT chk_task_events_level
      CHECK (level IN ('info', 'warning', 'error'));
  END IF;
END $$;
