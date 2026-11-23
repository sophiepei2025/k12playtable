/**
 * Qwen extraction pipeline: official page → proposed field patch → data/review/<id>.json
 * Nothing goes live until a human runs `npm run review -- approve <id>`.
 *
 *   npm run extract -- --limit 50              # plan only (dry run, default): shows cost estimate
 *   npm run extract -- --limit 50 --yes        # actually call the model
 *   npm run extract -- --ids shad-canada,mit-primes --yes
 *   npm run extract -- --candidates --yes      # new records from data/seed/candidates.csv
 *
 * Guard against hallucination: every extracted value must come with a quote that
 * appears verbatim (whitespace-insensitive) in the fetched page text; otherwise the
 * value is dropped. Same dry-run/--yes pattern as volcengine-ark-kit/experiments/cost_ab_test.py.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LlmClient, PRICE_USD, type LlmUsage } from "../src/core/llm.js";
import type { Activity } from "../src/core/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => path.join(ROOT, ...s);
const today = new Date().toISOString().slice(0, 10);

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const YES = flag("yes");
const CANDIDATES = flag("candidates");
const LIMIT = Number(opt("limit") ?? 20);
const IDS = opt("ids")?.split(",").map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Number(opt("concurrency") ?? 3);
const FORCE = flag("force");

// ---------- page fetch ----------
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EdmoatActivitiesBot/0.1; +https://edmoat.com)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text()).slice(0, 24_000);
}

// ---------- extraction schema ----------
const q = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v.nullable(), quote: z.string().nullable() }).nullable().optional();

export const Extracted = z.object({
  fee_type: q(z.enum(["free", "paid", "stipend"])),
  cost: q(z.object({ min: z.number(), max: z.number(), currency: z.enum(["USD", "CAD"]) })),
  aid: q(z.enum(["none", "need_based", "full_for_low_income", "merit"])),
  app_open: q(z.string()),
  app_deadline: q(z.string()),
  start: q(z.string()),
  end: q(z.string()),
  hours_per_week: q(z.number()),
  total_weeks: q(z.number()),
  selectivity: q(z.enum(["open", "selective", "highly_selective"])),
  acceptance_rate: q(z.number()),
  grades: q(z.array(z.number().int())),
  citizenship: q(z.array(z.string())),
  international_ok: q(z.boolean()),
  residential: q(z.boolean()),
  outputs: q(z.array(z.enum(["award", "paper", "college_credit", "rec_letter", "portfolio", "certificate", "stipend"]))),
  discontinued: q(z.boolean()),
  // candidates only
  name: q(z.string()),
  description: q(z.string()),
  category: q(z.enum(["Program", "Competition", "Academic Research", "Community Service", "Club"])),
  environment: q(z.enum(["in_person", "hybrid", "online"])),
  organizer_type: q(z.enum(["company", "nonprofit", "university_program", "education_org", "government"])),
  subjects: q(z.array(z.string())),
});
export type ExtractedT = z.infer<typeof Extracted>;

const SYSTEM = (candidate: boolean) => `You extract facts about a student program from its official web page text.
Return ONLY JSON. For each key, return {"value": ..., "quote": "..."} where quote is a short EXACT substring copied from the page that states the fact, or null if the page does not state it. Never guess; never use outside knowledge. If unsure, use null.
Keys:
- fee_type: free | paid | stipend (students are paid)
- cost: {min, max, currency USD|CAD} program fee for the student
- aid: none | need_based | full_for_low_income | merit
- app_open, app_deadline, start, end: dates as YYYY-MM-DD for the NEXT upcoming cycle after ${today}; if the year is not stated, null
- hours_per_week, total_weeks: numbers
- selectivity: open (anyone may join/register) | selective (application reviewed, limited spots) | highly_selective (states acceptance under ~10% or very competitive)
- acceptance_rate: 0-1 only if the page states a rate
- grades: list of eligible school grades (9-12)
- citizenship: e.g. ["US"], ["CA"] if restricted
- international_ok: true/false only if stated
- residential: true if students live on site
- outputs: what students get (award, paper, college_credit, rec_letter, portfolio, certificate, stipend)
- discontinued: true only if the page says the program ended
${candidate ? "- name, description (2 sentences, English), category, environment, organizer_type, subjects (short list)" : "Do not return name/description/category/environment/organizer_type/subjects."}`;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();

/** Drop any field whose quote is missing or not found in the page text. */
export function verifyQuotes(ex: ExtractedT, pageText: string): { kept: ExtractedT; dropped: string[] } {
  const hay = squash(pageText);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(ex)) {
    if (!v || v.value === null || v.value === undefined) continue;
    if (!v.quote || !hay.includes(squash(v.quote))) {
      dropped.push(k);
      continue;
    }
    kept[k] = v;
  }
  return { kept: kept as ExtractedT, dropped };
}

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Map verified extraction to an override patch (schema field names). */
export function toPatch(ex: ExtractedT): { patch: Record<string, unknown>; fields: string[] } {
  const patch: Record<string, unknown> = {};
  const fields: string[] = [];
  type Val<K extends keyof ExtractedT> = NonNullable<ExtractedT[K]>["value"] | null;
  const v = <K extends keyof ExtractedT>(k: K): Val<K> => ((ex[k] as { value?: unknown } | null | undefined)?.value ?? null) as Val<K>;
  const set = (field: string, apply: () => void) => {
    apply();
    fields.push(field);
  };
  if (v("fee_type")) set("fee_type", () => (patch.fee_type = v("fee_type")));
  const cost = v("cost");
  if (cost && cost.max >= cost.min) set("cost", () => (patch.cost = { ...cost, includes: ["tuition"] }));
  if (v("aid")) set("aid", () => (patch.aid = v("aid")));
  const dates: Record<string, string> = {};
  for (const k of ["app_open", "app_deadline", "start", "end"] as const) {
    const d = v(k);
    if (isDate(d)) {
      dates[k] = d as string;
      fields.push(`dates.${k}`);
    }
  }
  if (Object.keys(dates).length) patch.dates = dates;
  if (v("hours_per_week") !== null) set("hours_per_week", () => (patch.hours_per_week = v("hours_per_week")));
  if (v("total_weeks") !== null) set("total_weeks", () => (patch.total_weeks = v("total_weeks")));
  if (v("selectivity")) set("selectivity", () => (patch.selectivity = v("selectivity")));
  const rate = v("acceptance_rate");
  if (rate !== null && rate >= 0 && rate <= 1) set("acceptance_rate", () => (patch.acceptance_rate = rate));
  const elig: Record<string, unknown> = {};
  const grades = (v("grades") ?? []).filter((g) => g >= 6 && g <= 12);
  if (grades.length) {
    elig.grades = grades;
    patch.grades = grades;
    fields.push("eligibility.grades");
  }
  if (v("citizenship")?.length) {
    elig.citizenship = v("citizenship");
    fields.push("eligibility.citizenship");
  }
  if (v("international_ok") !== null) {
    elig.international_ok = v("international_ok");
    fields.push("eligibility.international_ok");
  }
  if (Object.keys(elig).length) patch.eligibility = elig;
  if (v("residential") !== null) set("residential", () => (patch.residential = v("residential")));
  if (v("outputs")?.length) set("outputs", () => (patch.outputs = v("outputs")));
  if (v("discontinued") === true) set("status", () => (patch.status = "discontinued"));
  return { patch, fields };
}

// ---------- targets ----------
interface Target {
  id: string;
  name: string;
  link: string;
  candidate: boolean;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function pickTargets(): Target[] {
  if (CANDIDATES) {
    const csv = readFileSync(p("data/seed/candidates.csv"), "utf8").trim().split("\n").slice(1);
    return csv.map((line) => {
      const [name, link] = line.split(",");
      return { id: slug(name), name: name.trim(), link: link.trim(), candidate: true };
    });
  }
  const list = JSON.parse(readFileSync(p("data/activities.json"), "utf8")) as Activity[];
  let pool = list.filter((a) => a.status === "active");
  if (IDS) pool = pool.filter((a) => IDS.includes(a.id));
  else
    pool = pool
      // priority: high school, not yet verified, in-person/hybrid programs with deadlines first
      .filter((a) => a.audience.includes("high_school") && !a.last_verified)
      .sort((a, b) => Number(b.region.country === "CA") - Number(a.region.country === "CA") || a.name.localeCompare(b.name));
  if (!FORCE) pool = pool.filter((a) => !existsSync(p("data/review", `${a.id}.json`)));
  return pool.slice(0, IDS ? undefined : LIMIT).map((a) => ({ id: a.id, name: a.name, link: a.link, candidate: false }));
}

// ---------- run ----------
async function runOne(client: LlmClient, t: Target) {
  const text = await fetchPage(t.link);
  mkdirSync(p("data/cache/pages"), { recursive: true });
  writeFileSync(p("data/cache/pages", `${t.id}.txt`), text);
  if (text.length < 200) throw new Error("page text too short (JS-rendered site?)");
  const raw = await client.chatJson("extract", SYSTEM(t.candidate), `Program: ${t.name}\nURL: ${t.link}\n\nPAGE TEXT:\n${text}`, Extracted, { maxTokens: 1200 });
  const { kept, dropped } = verifyQuotes(raw, text);
  const { patch, fields } = toPatch(kept);
  const review = {
    id: t.id,
    name: t.name,
    url: t.link,
    candidate: t.candidate,
    fetched_at: today,
    provider: client.provider,
    model: client.modelFor("extract"),
    proposed_patch: { ...patch, last_verified: today, sources: [t.link], verified_fields: fields },
    evidence: kept,
    dropped_unquoted: dropped,
  };
  writeFileSync(p("data/review", `${t.id}.json`), JSON.stringify(review, null, 2) + "\n");
  return { fields: fields.length, dropped: dropped.length };
}

async function main() {
  const targets = pickTargets();
  const usage: LlmUsage[] = [];
  const client = new LlmClient({ onUsage: (u: LlmUsage) => usage.push(u) });
  const model = client.modelFor("extract");
  const price = PRICE_USD[model];
  const estIn = 6500, estOut = 700; // tokens per page (24k chars ≈ 6k tokens + prompt)
  const est = price ? (targets.length * (estIn * price[0] + estOut * price[1])) / 1e6 : null;

  console.log(`\nextract: ${targets.length} page(s) · provider ${client.provider} · model ${model}`);
  for (const t of targets.slice(0, 15)) console.log(`  - ${t.id}  ${t.link}`);
  if (targets.length > 15) console.log(`  … and ${targets.length - 15} more`);
  console.log(`  estimated cost ≈ ${est === null ? "unknown (no price for model)" : `$${est.toFixed(4)}`} (realtime price; batch would be ~50%)\n`);

  if (!YES) {
    console.log("Dry run. Nothing was fetched or sent. Add --yes to run.");
    return;
  }
  if (!client.configured) {
    console.error("DASHSCOPE_API_KEY (or the key for LLM_PROVIDER) is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  mkdirSync(p("data/review"), { recursive: true });
  let ok = 0, failed = 0;
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          const r = await runOne(client, t);
          ok++;
          console.log(`  ✓ ${t.id}: ${r.fields} field(s) proposed${r.dropped ? `, ${r.dropped} dropped (quote not found)` : ""}`);
        } catch (e) {
          failed++;
          console.log(`  ✗ ${t.id}: ${(e as Error).message.slice(0, 160)}`);
        }
      }
    }),
  );
  const cost = usage.reduce((s, u) => s + (u.cost_usd ?? 0), 0);
  const tokens = usage.reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0);
  mkdirSync(p("data/cache"), { recursive: true });
  writeFileSync(p("data/cache/llm-usage.jsonl"), usage.map((u) => JSON.stringify({ ...u, at: new Date().toISOString() })).join("\n") + "\n", { flag: "a" });
  console.log(`\ndone: ${ok} ok, ${failed} failed · ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`);
  console.log("Next: npm run review -- list   then   npm run review -- approve <id>");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    process.loadEnvFile?.(p(".env"));
  } catch {
    /* no .env */
  }
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
