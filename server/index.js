import http from "node:http";
import { RtcTokenBuilder, RtcRole } from "agora-access-token";

const PORT = process.env.PORT || 6060;
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!APP_ID || !APP_CERTIFICATE) {
  console.error("AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set");
  process.exit(1);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return {
    pathname: url.pathname,
    params: url.searchParams,
  };
}

function generateToken(channelName, uid) {
  const expireSeconds = 3600;
  const role = RtcRole.PUBLISHER;
  return RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    role,
    expireSeconds,
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const { pathname, params } = parseUrl(req);

  if (pathname === "/token" && req.method === "GET") {
    const channelName = params.get("channel");
    const uidParam = params.get("uid");

    if (!channelName) {
      sendJson(res, 400, { error: "Missing 'channel' parameter" });
      return;
    }

    const uid = uidParam ? Number(uidParam) : 0;
    if (Number.isNaN(uid)) {
      sendJson(res, 400, { error: "'uid' must be a number" });
      return;
    }

    try {
      const token = generateToken(channelName, uid);
      sendJson(res, 200, { token, appId: APP_ID, uid });
    } catch (err) {
      console.error("Token generation failed:", err);
      sendJson(res, 500, { error: "Failed to generate token" });
    }
    return;
  }

  if (pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Agora token server listening on port ${PORT}`);
});
