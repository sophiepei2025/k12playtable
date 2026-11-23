import type { IncomingMessage, ServerResponse } from "node:http";
import { ACTIVITIES } from "../core/data.js";
import { getById, search, type SearchFilters } from "../core/search.js";
import { explainSignals } from "../core/signals.js";
import { parseQuery } from "../core/nlquery.js";

/** Public JSON API (no key). Same core as the MCP tools. */

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v: string | null) => (v === null || v === "" ? undefined : Number(v));
const bool = (v: string | null) => (v === null ? undefined : v === "true" || v === "1");

export function filtersFromQuery(sp: URLSearchParams): SearchFilters {
  return {
    q: sp.get("q") ?? undefined,
    audience: list(sp.get("audience")) as SearchFilters["audience"],
    grade: num(sp.get("grade")),
    subjects: list(sp.get("subjects")),
    category: list(sp.get("category")),
    environment: list(sp.get("environment")) as SearchFilters["environment"],
    commitment: (sp.get("commitment") ?? undefined) as SearchFilters["commitment"],
    organizer_type: list(sp.get("organizer_type")) as SearchFilters["organizer_type"],
    big_company: bool(sp.get("big_company")),
    country: list(sp.get("country")) as SearchFilters["country"],
    fee: (sp.get("fee") ?? undefined) as SearchFilters["fee"],
    max_cost: num(sp.get("max_cost")),
    deadline_month: num(sp.get("deadline_month")),
    international_ok: bool(sp.get("international_ok")),
    selective_only: bool(sp.get("selective_only")),
    verified_only: bool(sp.get("verified_only")),
    include_discontinued: bool(sp.get("include_discontinued")),
    sort: (sp.get("sort") ?? undefined) as SearchFilters["sort"],
    limit: num(sp.get("limit")),
    offset: num(sp.get("offset")),
  };
}

/** GET /api/activities?q=&grade=…   ·   GET /api/activities?id=shad-canada */
export async function handleActivities(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url || "/", "http://x");
  const id = url.searchParams.get("id");
  if (id) {
    const a = getById(ACTIVITIES, id);
    return a ? send(res, 200, { activity: a, signals: explainSignals(a) }, { "Cache-Control": "public, max-age=300" }) : send(res, 404, { error: `No activity ${id}` });
  }
  return send(res, 200, search(ACTIVITIES, filtersFromQuery(url.searchParams)), { "Cache-Control": "public, max-age=300" });
}

async function readBody(req: IncomingMessage, max = 4_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** POST /api/parse-query {text} → {filters, source}. Qwen (US) when configured, keyword fallback otherwise. */
export async function handleParseQuery(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST {text}" });
  try {
    const raw = (req as IncomingMessage & { body?: unknown }).body; // Vercel pre-parses JSON
    const body = (raw && typeof raw === "object" ? raw : JSON.parse((await readBody(req)) || "{}")) as { text?: string };
    const text = String(body.text ?? "").slice(0, 400);
    if (!text.trim()) return send(res, 400, { error: "text is required" });
    const out = await parseQuery(text, ACTIVITIES);
    return send(res, 200, out);
  } catch (e) {
    return send(res, 400, { error: (e as Error).message });
  }
}
