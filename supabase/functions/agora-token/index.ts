const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ── Agora RTC token builder (AccessToken2) ───────────────────────────
// Implements the AccessToken2 spec used by Agora RTC SDK v4+.

const VERSION = "007";
const SERVICE_TYPE_RTC = 1;

const KJoinChannel = 1;
const KPublishAudioStream = 2;
const KPublishVideoStream = 3;
const KPublishDataStream = 4;

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function crc32(data: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packUint16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (v >>> 8) & 0xff;
  b[1] = v & 0xff;
  return b;
}

function packUint32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function packString(s: string): Uint8Array {
  const enc = new TextEncoder();
  const strBytes = enc.encode(s);
  const b = new Uint8Array(2 + strBytes.length);
  b.set(packUint16(strBytes.length), 0);
  b.set(strBytes, 2);
  return b;
}

function packMapUint32(map: Map<number, number>): Uint8Array {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const parts: Uint8Array[] = [packUint16(map.size)];
  for (const k of keys) {
    parts.push(packUint16(k));
    parts.push(packUint32(map.get(k)!));
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function hmacSha256Sign(key: Uint8Array, message: Uint8Array): Promise<ArrayBuffer> {
  const c = globalThis.crypto;
  return c.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  ).then((k) => c.subtle.sign("HMAC", k, message));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

interface AccessTokenContent {
  appId: string;
  appCert: string;
  issueTs: number;
  salt: number;
  services: Map<number, Map<number, number>>;
}

class AccessToken {
  content: AccessTokenContent;

  constructor(appId: string, appCert: string) {
    this.content = {
      appId,
      appCert,
      issueTs: Math.floor(Date.now() / 1000),
      salt: randomUint32(),
      services: new Map(),
    };
  }

  addService(serviceType: number): Map<number, number> {
    let svc = this.content.services.get(serviceType);
    if (!svc) {
      svc = new Map();
      this.content.services.set(serviceType, svc);
    }
    return svc;
  }

  addPrivilege(serviceType: number, privilege: number, expireTs: number) {
    const svc = this.addService(serviceType);
    svc.set(privilege, expireTs);
  }

  serializeContent(): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(packString(this.content.appId));
    parts.push(packUint32(this.content.issueTs));
    parts.push(packUint32(this.content.salt));

    const services = [...this.content.services.keys()].sort((a, b) => a - b);
    parts.push(packUint16(services.length));
    for (const svcType of services) {
      parts.push(packUint16(svcType));
      parts.push(packMapUint32(this.content.services.get(svcType)!));
    }

    return concatBytes(parts);
  }

  build(): Promise<string> {
    return this.sign();
  }

  private async sign(): Promise<string> {
    const content = this.serializeContent();
    const appCertBytes = hexToBytes(this.content.appCert);

    const signatureBuf = await hmacSha256Sign(appCertBytes, content);
    const signatureBytes = new Uint8Array(signatureBuf);

    const contentCrc = crc32(content);
    const sigCrc = crc32(signatureBytes);

    const parts: Uint8Array[] = [];
    parts.push(new TextEncoder().encode(VERSION));
    parts.push(hexToBytes(this.content.appId));
    parts.push(signatureBytes);
    parts.push(packUint32(contentCrc));
    parts.push(packUint32(sigCrc));
    parts.push(content);

    const all = concatBytes(parts);
    return base64Encode(all);
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function buildRtcToken(
  appId: string,
  appCert: string,
  channelName: string,
  uid: number,
  expireTs: number,
): Promise<string> {
  const token = new AccessToken(appId, appCert);
  token.addPrivilege(SERVICE_TYPE_RTC, KJoinChannel, expireTs);
  token.addPrivilege(SERVICE_TYPE_RTC, KPublishAudioStream, expireTs);
  token.addPrivilege(SERVICE_TYPE_RTC, KPublishVideoStream, expireTs);
  token.addPrivilege(SERVICE_TYPE_RTC, KPublishDataStream, expireTs);
  return token.build();
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

    const appId = Deno.env.get("AGORA_APP_ID");
    const appCert = Deno.env.get("AGORA_APP_CERTIFICATE");

    if (!appId || !appCert) {
      console.error("[agora-token] Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE");
      return new Response(
        JSON.stringify({ error: "Server is not configured for Agora token generation" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const expireTs = Math.floor(Date.now() / 1000) + 3600;

    const token = await buildRtcToken(
      appId,
      appCert,
      channelName,
      uid,
      expireTs,
    );

    return new Response(
      JSON.stringify({
        token,
        uid,
        expireTs,
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
