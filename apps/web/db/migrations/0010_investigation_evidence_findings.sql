CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES investigation_nodes(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES session_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES investigation_nodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_investigation_id
  ON evidence_artifacts(investigation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_findings_investigation_id
  ON findings(investigation_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_findings_severity'
      AND conrelid = 'findings'::regclass
  ) THEN
    ALTER TABLE findings
      ADD CONSTRAINT chk_findings_severity
      CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
  END IF;
END $$;
