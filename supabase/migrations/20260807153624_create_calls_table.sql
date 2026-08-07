/*
# Create calls table for single-room call mode

1. New Tables
- `calls`
  - `id` (uuid, primary key)
  - `access_code` (text, unique, not null) — 6-digit numeric code guests use to join
  - `channel_name` (text, not null) — fixed Agora channel name ("main-call-room")
  - `status` (text, not null, default 'waiting') — one of: waiting, active, ended
  - `host_display_name` (text) — display name the host entered
  - `created_at` (timestamptz, default now())
  - `ended_at` (timestamptz) — set when the host ends the call

2. Security
- Enable RLS on `calls`.
- Allow anon + authenticated CRUD since this is a no-auth single-tenant app.
- All policies use `TO anon, authenticated` so the anon-key frontend can read/write.

3. Important Notes
- The access_code is generated client-side and inserted when the host starts a call.
- The guest validates the code by querying this table.
- When the host ends the call, status is set to 'ended' and ended_at is set.
- Guests cannot reopen an ended call (frontend checks status === 'ended').
- The channel_name is always "main-call-room" — all calls share the same Agora channel.
*/

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_code text UNIQUE NOT NULL,
  channel_name text NOT NULL DEFAULT 'main-call-room',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'ended')),
  host_display_name text,
  created_at timestamptz DEFAULT now(),
  ended_at timestamptz
);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_calls" ON calls;
CREATE POLICY "anon_select_calls" ON calls FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_calls" ON calls;
CREATE POLICY "anon_insert_calls" ON calls FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_calls" ON calls;
CREATE POLICY "anon_update_calls" ON calls FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_calls" ON calls;
CREATE POLICY "anon_delete_calls" ON calls FOR DELETE
  TO anon, authenticated USING (true);
