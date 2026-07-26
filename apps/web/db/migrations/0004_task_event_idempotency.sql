ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_idempotency_key
  ON task_events(task_id, agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
