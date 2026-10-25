#!/usr/bin/env node
// Issue MCP OAuth credentials for a headless agent against any Agenvo relay.
// Usage:
//   AGENVO_ADMIN_SECRET=... AGENVO_BASE_URL=https://relay.example.com node issue-token.mjs "agent-name"
// Output: JSON with client_id + access_token (15min) + refresh_token (rotating).
// Refresh: POST {base}/token  grant_type=refresh_token&client_id=...&refresh_token=...
// NOTE: refresh tokens are single-use and rotate; store the new one each refresh —
//       replaying an old refresh token revokes the whole grant.
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.AGENVO_BASE_URL ?? "https://relay.example.com";
if (BASE === "https://relay.example.com") {
  console.error("Set AGENVO_BASE_URL to your relay origin (e.g. https://relay.example.com[/prefix])");
  process.exit(1);
}
const NAME = process.argv[2] || "headless-agent";
const SECRET = process.env.AGENVO_ADMIN_SECRET;
if (!SECRET) {
  console.error("Set AGENVO_ADMIN_SECRET (on the relay host: /etc/agenvo/admin.env)");
  process.exit(1);
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const verifier = b64u(randomBytes(48));
const challenge = b64u(createHash("sha256").update(verifier).digest());
const log = (...a) => console.error("[issue]", ...a);

// 1. dynamic registration
const reg = await fetch(BASE + "/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: NAME,
    redirect_uris: ["http://127.0.0.1/loopback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    code_challenge_method: "S256",
  }),
});
if (!reg.ok) throw new Error("register " + reg.status + ": " + (await reg.text()));
const client = await reg.json();
log("registered:", client.client_id);

// 2. authorize -> login -> consent
const authUrl = new URL(BASE + "/authorize");
for (const [k, v] of Object.entries({
  response_type: "code", client_id: client.client_id,
  redirect_uri: "http://127.0.0.1/loopback",
  code_challenge: challenge, code_challenge_method: "S256", state: randomUUID(),
})) authUrl.searchParams.set(k, v);

let cookie = "";
let current = authUrl;
let code = null;
for (let hop = 0; hop < 8 && !code; hop++) {
  const res = await fetch(current, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) {
    if (loc.startsWith("http://127.0.0.1/loopback")) {
      code = new URL(loc).searchParams.get("code");
      if (!code) throw new Error("authorize failed: " + loc);
      break;
    }
    current = loc.includes("/authorize") ? authUrl
      : loc.startsWith("http") ? new URL(loc) : new URL(loc, current);
    continue;
  }
  const html = await res.text();
  const form = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) form[m[1]] = m[2];
  const body = new URLSearchParams(form);
  if (html.includes('name="secret"')) body.set("secret", SECRET);
  if (html.includes('name="decision"')) body.set("decision", "approve");
  const post = await fetch(current, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: new URL(BASE).origin },
    body,
  });
  const sc2 = post.headers.get("set-cookie");
  if (sc2) cookie = sc2.split(";")[0];
  const loc2 = post.headers.get("location");
  if (loc2) {
    if (loc2.startsWith("http://127.0.0.1/loopback")) { code = new URL(loc2).searchParams.get("code"); break; }
    current = loc2.includes("/authorize") ? authUrl
      : loc2.startsWith("http") ? new URL(loc2) : new URL(loc2, current);
    continue;
  }
  const page = await post.text();
  const link = page.match(/href="(http:\/\/127\.0\.0\.1\/loopback[^"]*)"/);
  if (link) { code = new URL(link[1].replace(/&amp;/g, "&")).searchParams.get("code"); break; }
  throw new Error("unexpected page: " + page.slice(0, 160));
}
if (!code) throw new Error("no authorization code");
log("authorized ✓");

// 3. token exchange
const tokenRes = await fetch(BASE + "/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", code,
    redirect_uri: "http://127.0.0.1/loopback",
    client_id: client.client_id, code_verifier: verifier,
  }),
});
const token = await tokenRes.json();
if (!token.access_token) throw new Error("token failed: " + JSON.stringify(token).slice(0, 200));

const result = {
  name: NAME,
  endpoint: BASE + "/mcp",
  client_id: client.client_id,
  access_token: token.access_token,
  access_expires_in: token.expires_in,
  refresh_token: token.refresh_token,
  issued_at: new Date().toISOString(),
  refresh_hint:
    "POST " + BASE + "/token with grant_type=refresh_token&client_id=" +
    client.client_id + "&refresh_token=<current>; response carries a NEW refresh_token — " +
    "old one is single-use, replaying it revokes the grant. Persist the rotation.",
};
const dir = join(homedir(), ".config", "agenvo", "zcode", "tokens");
mkdirSync(dir, { recursive: true });
const file = join(dir, NAME + ".json");
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, file }, null, 2));
