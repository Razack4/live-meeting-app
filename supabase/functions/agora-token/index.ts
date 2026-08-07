import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ── Agora AccessToken2 builder (version "007") ─────────────────────
// Mirrors Agora's official RtcTokenBuilder2 reference implementation:
//   - HMAC-SHA256 with appCertificate as key, signingInfo as message
//   - Signature packed as a 64-char hex string (not raw bytes)
//   - expireTs is an ABSOLUTE Unix timestamp (issueTs + expireSeconds)
//   - Privilege values are absolute expireTs, not durations
//   - Payload compressed with zlib format (RFC 1950), not raw deflate

const VERSION = "007";

const PRIV_JOIN_CHANNEL = 1;
const PRIV_PUBLISH_AUDIO = 2;
const PRIV_PUBLISH_VIDEO = 3;
const PRIV_PUBLISH_DATA = 4;

const SERVICE_TYPE_RTC = 1;

const enc = new TextEncoder();

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, false);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function packString(s: string): Uint8Array {
  const bytes = enc.encode(s);
  return concat([u16(bytes.length), bytes]);
}

function packMapU32(m: Map<number, number>): Uint8Array {
  const keys = [...m.keys()].sort((a, b) => a - b);
  const parts: Uint8Array[] = [u16(keys.length)];
  for (const k of keys) parts.push(u16(k), u32(m.get(k)!));
  return concat(parts);
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, toArrayBuffer(msg));
  return new Uint8Array(sig);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Produce zlib-format (RFC 1950) compressed data:
//   [2-byte header][raw deflate body][4-byte Adler-32 trailer]
// CompressionStream("deflate") gives raw deflate (RFC 1951);
// we wrap it with the zlib header and checksum that Agora expects.
async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(toArrayBuffer(data));
  writer.close();
  const rawDeflate = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  const header = new Uint8Array([0x78, 0x01]); // CMF=0x78, FLG=0x01
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler32(data), false);

  return concat([header, rawDeflate, trailer]);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function buildRtcToken(
  appId: string,
  appCertificate: string,
  channel: string,
  uid: number,
  expireSeconds: number,
): Promise<string> {
  const issueTs = Math.floor(Date.now() / 1000);
  const expireTs = issueTs + expireSeconds;
  const salt = Math.floor(Math.random() * 99999999) + 1;

  const privileges = new Map<number, number>([
    [PRIV_JOIN_CHANNEL, expireTs],
    [PRIV_PUBLISH_AUDIO, expireTs],
    [PRIV_PUBLISH_VIDEO, expireTs],
    [PRIV_PUBLISH_DATA, expireTs],
  ]);

  const uidStr = uid === 0 ? "" : String(uid);

  const service = concat([
    u16(SERVICE_TYPE_RTC),
    packMapU32(privileges),
    packString(channel),
    packString(uidStr),
  ]);

  const signingInfo = concat([
    packString(appId),
    u32(issueTs),
    u32(expireTs),
    u32(salt),
    u16(1),
    service,
  ]);

  // Single HMAC-SHA256: key = appCertificate (UTF-8 bytes), msg = signingInfo
  const sigBytes = await hmac(enc.encode(appCertificate), signingInfo);
  const signature = bytesToHex(sigBytes);

  const content = concat([packString(signature), signingInfo]);
  const compressed = await zlibCompress(content);
  return VERSION + base64(compressed);
}

// ── Credential retrieval ────────────────────────────────────────────
// Agora credentials are stored in the app_config table (RLS-protected,
// server-only). The edge function uses the service role key to read them.

async function getAgoraCredentials(): Promise<{ appId: string; appCert: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase configuration for edge function.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await supabase
    .from("app_config")
    .select("key, value")
    .in("key", ["AGORA_APP_ID", "AGORA_APP_CERTIFICATE"]);

  if (error) {
    throw new Error("Failed to read Agora credentials from database.");
  }

  const config = new Map(
    data.map((row: { key: string; value: string }) => [row.key, row.value]),
  );
  const appId = config.get("AGORA_APP_ID");
  const appCert = config.get("AGORA_APP_CERTIFICATE");

  if (!appId || !appCert) {
    throw new Error("Agora credentials not found in database.");
  }

  return { appId, appCert };
}

// ── Main handler ─────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    let channelName: string | undefined;
    let uid: number | undefined;

    if (req.method === "GET") {
      channelName = url.searchParams.get("channel") ?? undefined;
      const uidParam = url.searchParams.get("uid");
      uid = uidParam ? parseInt(uidParam, 10) : undefined;
    } else {
      const body = await req.json();
      channelName = body.channel;
      uid = body.uid !== undefined ? Number(body.uid) : undefined;
    }

    if (!channelName) {
      return new Response(
        JSON.stringify({ error: "Missing 'channel' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (uid === undefined || isNaN(uid)) {
      uid = 0;
    }

    const { appId, appCert } = await getAgoraCredentials();

    const expireSeconds = 3600;
    const issueTs = Math.floor(Date.now() / 1000);

    const token = await buildRtcToken(
      appId,
      appCert,
      channelName,
      uid,
      expireSeconds,
    );

    return new Response(
      JSON.stringify({
        token,
        uid,
        expireTs: issueTs + expireSeconds,
        appId,
        channelName,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[agora-token] error", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
