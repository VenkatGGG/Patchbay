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
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  tailscale JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(environment_id, name)
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

CREATE TABLE IF NOT EXISTS session_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_sessions_environment_id ON sessions(environment_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_session_id ON session_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_session_tasks_agent_status ON session_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_task_events_session_id ON task_events(session_id);
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
