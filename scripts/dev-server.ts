/** Local preview: static public/ + /api/* + /mcp on one port (default 3000). Mirrors vercel.json. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleHttpRequest } from "../src/mcp/http.js";
import { handleActivities, handleParseQuery } from "../src/api/handlers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
try { process.loadEnvFile?.(path.join(ROOT, "..", ".env")); } catch { /* optional */ }

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/mcp" || url.pathname === "/health") return await handleHttpRequest(req, res);
    if (url.pathname === "/api/activities") return await handleActivities(req, res);
    if (url.pathname === "/api/parse-query") return await handleParseQuery(req, res);
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(ROOT)) throw new Error("bad path");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(Number(process.env.PORT || 3000), () => console.log(`preview: http://localhost:${process.env.PORT || 3000}  ·  MCP: /mcp`));
