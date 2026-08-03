ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS capability_packs JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_agents_capability_packs_array'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT chk_agents_capability_packs_array
      CHECK (jsonb_typeof(capability_packs) = 'array');
  END IF;
END $$;
