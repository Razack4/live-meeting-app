/*
# Create temp table for key recovery

1. Creates a temporary table `recovery_keys` to store the anon key written by the edge function.
2. Allows public read/write so the anon-key edge function (running as anon) can insert into it.
3. Will be dropped after recovery is complete.
*/

CREATE TABLE IF NOT EXISTS recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_name text,
  key_value text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE recovery_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_recovery_keys" ON recovery_keys;
CREATE POLICY "anon_all_recovery_keys" ON recovery_keys
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
