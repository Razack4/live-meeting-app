/*
# Install pg_net extension temporarily

1. Installs `pg_net` to attempt an internal HTTP call to the edge function.
2. Used to retrieve the current valid anon key from the edge function environment.
3. Will be dropped after recovery is complete.
*/

CREATE EXTENSION IF NOT EXISTS pg_net;
