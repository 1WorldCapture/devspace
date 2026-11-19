import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** OAuth client ID recorded for requests authenticated by the local access token. */
export const LOCAL_ACCESS_CLIENT_ID = "devspace-local";

/**
 * Static bearer token for agents on this machine that connect to the loopback
 * `/mcp` URL without OAuth. It is derived from the owner password, so changing
 * that password also revokes this token.
 */
export function localAccessToken(ownerToken: string): string {
  return createHmac("sha256", ownerToken).update("devspace-local-mcp-access").digest("base64url");
}

/**
 * A tunnel also connects from loopback, so the peer address alone proves
 * nothing: the request must present the token, come from a loopback peer, and
 * name a loopback Host, which tunnels that keep the public Host never do.
 */
export function isLocalAccessRequest(req: IncomingMessage, token: string): boolean {
  const presented = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];

  if (!presented || !safeEquals(presented, token)) return false;

  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? "")) return false;

  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${req.headers.host ?? ""}`).hostname);
  } catch {
    return false;
  }
}

/** Prompt a user pastes into any coding agent so it adds DevSpace to its own MCP config. */
export function localAgentConnectPrompt(mcpUrl: string, token: string): string {
  return [
    "Connect yourself to my local DevSpace MCP server.",
    "",
    "Add an MCP server to your own configuration, at user (global) scope so it is available in every project:",
    "- Name: devspace",
    "- Transport: Streamable HTTP",
    `- URL: ${mcpUrl}`,
    `- Header: Authorization: Bearer ${token}`,
    "",
    "Use your own command for adding MCP servers if you have one; otherwise edit your MCP configuration file. "
    + `For example, in Claude Code: claude mcp add --transport http --scope user devspace ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    "",
    "The header authenticates the connection, so do not start an OAuth login for this server.",
    "The token is a secret: store it only in your MCP configuration, never in project files, and do not repeat it in your reply.",
    "When you are done, tell me where you saved the configuration and whether I need to restart or reload you before the DevSpace tools appear.",
  ].join("\n");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
