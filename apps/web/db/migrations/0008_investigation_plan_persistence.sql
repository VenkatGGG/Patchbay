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

CREATE INDEX IF NOT EXISTS idx_investigations_session_id
  ON investigations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_investigation_nodes_investigation_id
  ON investigation_nodes(investigation_id, created_at);

DO $$
BEGIN
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
END $$;
