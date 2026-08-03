ALTER TABLE session_tasks
  ADD COLUMN IF NOT EXISTS investigation_node_id TEXT
    REFERENCES investigation_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_tasks_investigation_node_id
  ON session_tasks(investigation_node_id)
  WHERE investigation_node_id IS NOT NULL;
