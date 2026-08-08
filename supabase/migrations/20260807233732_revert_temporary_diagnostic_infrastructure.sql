-- Revert temporary diagnostic infrastructure

-- 1. Drop the recovery_keys table created during investigation
DROP TABLE IF EXISTS recovery_keys;

-- 2. Drop the pg_net extension installed temporarily
DROP EXTENSION IF EXISTS pg_net;

-- 3. Drop the http extension installed temporarily
DROP EXTENSION IF EXISTS http;
