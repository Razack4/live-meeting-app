import { createClient } from "@supabase/supabase-js";

export const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL;
export const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.SUPABASE_ANON_KEY;

console.log("[SUPABASE-INIT] supabaseUrl:", supabaseUrl || "(undefined)");
console.log("[SUPABASE-INIT] supabaseAnonKey present:", !!supabaseAnonKey);
console.log("[SUPABASE-INIT] import.meta.env.VITE_SUPABASE_URL:", import.meta.env.VITE_SUPABASE_URL || "(undefined)");
console.log("[SUPABASE-INIT] import.meta.env.SUPABASE_URL:", import.meta.env.SUPABASE_URL || "(undefined)");
console.log("[SUPABASE-INIT] import.meta.env.VITE_SUPABASE_ANON_KEY present:", !!import.meta.env.VITE_SUPABASE_ANON_KEY);
console.log("[SUPABASE-INIT] import.meta.env.SUPABASE_ANON_KEY present:", !!import.meta.env.SUPABASE_ANON_KEY);

export const supabase = createClient(
  supabaseUrl || "https://unconfigured.supabase.co",
  supabaseAnonKey || "unconfigured-anon-key",
);

console.log("[SUPABASE-INIT] client created, supabaseUrl used:", supabaseUrl || "(undefined)");
