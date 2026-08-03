ALTER TABLE session_tasks
  ALTER COLUMN agent_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_tasks_queued_capability
  ON session_tasks(capability, created_at)
  WHERE status = 'queued' AND agent_id IS NULL;
