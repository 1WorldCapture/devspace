import { isJsonString } from "./json-value.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { localAccessToken } from "./local-access.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

test("HTTP MCP enforces canonical and exact alias bearer resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-oauth-"));
  const canonical = "https://agent.example.com/mcp";
  const alias = "https://tunnel.example.com/v1/mcp/tunnel_123";

  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://agent.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    oauth: { allowedResourceUrls: [alias] },
    logging: { level: "silent" },
  }));

  const store = new SqliteOAuthStore(config.stateDir);

  const client = store.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  }, config.oauth.allowedRedirectHosts);

  const cases = [
    { resource: canonical, accepted: true },
    { resource: alias, accepted: true },
    { resource: `${alias}/child`, accepted: false },
    { resource: `${alias}?other=1`, accepted: false },
    { resource: "https://tunnel.example.com/v1/mcp/other", accepted: false },
  ];

  for (const { resource } of cases) {
    store.saveAccessToken(createHash("sha256").update(resource).digest("base64url"), {
      clientId: client.client_id, scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resource,
    });
  }

  store.close();
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && !isJsonString(address));

  for (const { resource, accepted } of cases) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resource}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resource-test", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(5000),
    });

    const body = await response.text();
    assert.equal(response.status, accepted ? 200 : 401, `${resource}: ${body}`);

    if (accepted) assert.match(body, /"serverInfo"/);
  }
});

test("HTTP MCP accepts the local access token only for loopback Hosts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-local-"));

  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://tunnel.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent" },
  }));

  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && !isJsonString(address));
  const localToken = localAccessToken(config.oauth.ownerToken);

  const cases = [
    { host: `127.0.0.1:${address.port}`, token: localToken, status: 200 },
    { host: `localhost:${address.port}`, token: localToken, status: 200 },
    // A tunnel connects from loopback too but forwards its public Host.
    { host: "tunnel.example.com", token: localToken, status: 401 },
    { host: `127.0.0.1:${address.port}`, token: config.oauth.ownerToken, status: 401 },
    { host: `127.0.0.1:${address.port}`, token: `${localToken}x`, status: 401 },
  ];

  for (const { host, token, status } of cases) {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "local-test", version: "1.0.0" } },
    });

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });

      req.on("error", reject);
      req.end(body);
    });

    assert.equal(response.status, status, `${host} ${token === localToken ? "local token" : "other token"}: ${response.body}`);

    if (status === 200) assert.match(response.body, /"serverInfo"/);
  }
});
