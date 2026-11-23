#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createExtracurricularMcpServer } from "./server.js";
import { ACTIVITIES } from "../core/data.js";

/**
 * Stateless Streamable HTTP (same as edmoat-seo-geo-mcp), without the legacy
 * SSE endpoint: SSE keeps sessions in memory, which breaks across Vercel instances.
 *
 * Auth model (MVP):
 * - Free tools: anonymous.
 * - Paid tools: `Authorization: Bearer <token>` where token is in PAID_ACCESS_TOKENS
 *   (comma-separated). Stopgap until per-family OAuth 2.1.
 */

export function isPaid(req: IncomingMessage, env: Record<string, string | undefined> = process.env): boolean {
  const tokens = (env.PAID_ACCESS_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return false;
  const auth = req.headers.authorization ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && tokens.includes(m[1].trim());
}

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "edmoat-extracurriculars-mcp",
        version: "0.1.0",
        transport: { streamableHttp: "/mcp" },
        activities: ACTIVITIES.length,
        paidToolsConfigured: Boolean(process.env.PAID_ACCESS_TOKENS),
      }),
    );
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
    const mcpServer = createExtracurricularMcpServer({ paid: isPaid(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

if (process.argv[1]?.endsWith("http.js") || process.argv[1]?.endsWith("http.ts")) {
  const port = Number(process.env.PORT || 3333);
  createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => {
      console.error("[extracurriculars-mcp] HTTP error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }).listen(port, () => console.log(`[extracurriculars-mcp] http://localhost:${port}/mcp`));
}
