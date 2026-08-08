/*
# Install http extension temporarily

1. Installs the `http` extension to allow outbound HTTP calls from the database.
2. Used to call the recover-anon-key edge function to retrieve the current valid anon key.
3. This extension will be dropped after recovery is complete.
*/

CREATE EXTENSION IF NOT EXISTS http;
