/**
 * Check all links in data/activities.json (HEAD -> fallback GET, timeout 10s, concurrency 5).
 * Saves results to data/cache/link-check.json. Does NOT modify any data files.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Activity } from "../src/core/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => path.join(ROOT, ...s);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type LinkStatus = "ok" | "redirect" | "404" | "timeout" | "blocked" | "error";

interface LinkCheckResult {
  id: string;
  name: string;
  url: string;
  status: LinkStatus;
  http_status: number | null;
  final_url: string | null;
  error?: string;
}

async function checkOne(url: string): Promise<{ status: LinkStatus; http_status: number | null; final_url: string | null; error?: string }> {
  const tryMethod = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    return res;
  };

  try {
    let res = await tryMethod("HEAD");
    if (res.status === 405 || res.status === 403 || res.status === 400 || res.status >= 500) {
      try {
        res = await tryMethod("GET");
      } catch {
        // keep HEAD response if GET fails
      }
    }
    const finalUrl = res.url && res.url !== url ? res.url : null;
    if (res.status === 404 || res.status === 410) {
      return { status: "404", http_status: res.status, final_url: finalUrl };
    }
    if (res.status === 403 || res.status === 401) {
      return { status: "blocked", http_status: res.status, final_url: finalUrl };
    }
    if (res.ok) {
      return { status: finalUrl ? "redirect" : "ok", http_status: res.status, final_url: finalUrl };
    }
    return { status: "error", http_status: res.status, final_url: finalUrl, error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/timeout|aborted/i.test(msg)) {
      return { status: "timeout", http_status: null, final_url: null, error: msg.slice(0, 120) };
    }
    return { status: "error", http_status: null, final_url: null, error: msg.slice(0, 120) };
  }
}

async function main() {
  const activities = JSON.parse(readFileSync(p("data/activities.json"), "utf8")) as Activity[];
  const queue = [...activities];
  const results: LinkCheckResult[] = [];
  const CONCURRENCY = 5;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const r = await checkOne(a.link);
        results.push({ id: a.id, name: a.name, url: a.link, ...r });
      }
    }),
  );

  results.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(p("data/cache"), { recursive: true });
  writeFileSync(p("data/cache/link-check.json"), JSON.stringify(results, null, 2) + "\n");

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log("Link check summary:", counts);
  console.log("\n404s:");
  for (const r of results.filter((x) => x.status === "404")) console.log(`  - ${r.id} (${r.http_status}): ${r.url}`);
  console.log("\nErrors/Timeouts:");
  for (const r of results.filter((x) => x.status === "error" || x.status === "timeout")) console.log(`  - ${r.id} [${r.status}]: ${r.url} (${r.error})`);
}

main();
