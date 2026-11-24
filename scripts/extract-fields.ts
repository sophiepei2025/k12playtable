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
import { LlmClient, PROVIDERS, priceFor, type LlmUsage } from "../src/core/llm.js";
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
const q = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ value: v.nullable().optional(), quote: z.string().nullable().optional() }).nullable().optional();

export const Extracted = z.object({
  fee_type: q(z.enum(["free", "paid", "stipend"])),
  cost: q(z.object({ min: z.number(), max: z.number(), currency: z.enum(["USD", "CAD"]).default("USD") })),
  aid: q(z.enum(["none", "need_based", "full_for_low_income", "merit"])),
  app_open: q(z.string()),
  app_deadline: q(z.string()),
  start: q(z.string()),
  end: q(z.string()),
  hours_per_week: q(z.number()),
  total_weeks: q(z.number()),
  selectivity: q(z.enum(["open", "selective", "highly_selective"])),
  acceptance_rate: q(z.number()),
  grades: q(z.array(z.union([z.number(), z.string()]))), // model sometimes returns "9-12" strings
  citizenship: q(z.array(z.string())),
  international_ok: q(z.boolean()),
  residential: q(z.boolean()),
  outputs: q(z.array(z.enum(["award", "paper", "college_credit", "rec_letter", "portfolio", "certificate", "stipend"]))),
  discontinued: q(z.boolean()),
  city: q(z.string()),
  sessions_per_week: q(z.number()),
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
Return ONLY JSON. For each key, return {"value": ..., "quote": "..."} where quote is a full, exact sentence or phrase (>= 20 characters) copied verbatim from the page that states the fact, or null if the page does not state it. Never guess; never use outside knowledge. If unsure, use null.
Keys:
- fee_type: free | paid | stipend (students are paid)
- cost: {min, max, currency USD|CAD} program fee for the student
- aid: none | need_based | full_for_low_income (only if page explicitly states full / 100% / no cost) | merit
- app_open, app_deadline, start, end: dates as YYYY-MM-DD for the NEXT upcoming cycle after ${today}; if the year is not stated, infer the next upcoming year or leave null
- hours_per_week, total_weeks: numbers (quote must include the number and unit like week/hour)
- selectivity: open (anyone may join/register) | selective (application reviewed, limited spots) | highly_selective (states acceptance under ~10% or very competitive)
- acceptance_rate: 0-1 only if the page states a rate
- grades: list of eligible school grades as integers, e.g. [9, 10, 11, 12]; expand ranges like "9-12" into separate integers
- citizenship: e.g. ["US"], ["CA"] only if eligibility/citizenship/residency restriction is explicitly stated
- international_ok: true/false only if explicitly stated
- residential: true if students live on site
- outputs: what students get (award, paper, college_credit, rec_letter, portfolio, certificate, stipend)
- discontinued: true only if the page says the program ended
- city: city where in-person sessions happen (e.g. "Toronto"), null if online-only or not stated
- sessions_per_week: how many times per week students attend (quote must include the number and unit)
${candidate ? "- name, description (2 sentences, English), category, environment, organizer_type, subjects (short list)" : "Do not return name/description/category/environment/organizer_type/subjects."}`;

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();

export interface WeakEvidenceItem {
  field: string;
  value: unknown;
  quote: string;
  reason: string;
}

const NUMERIC_UNIT_RULES: Record<string, { unitRe: RegExp; label: string }> = {
  hours_per_week: { unitRe: /\b(hours?|hrs?)\b/i, label: "hour/hr" },
  total_weeks: { unitRe: /\b(weeks?|wks?|months?|days?)\b/i, label: "week/month/day" },
  sessions_per_week: { unitRe: /\b(sessions?|days?|times?|meetings?|classes?|weeks?)\b/i, label: "session/day/time" },
  acceptance_rate: { unitRe: /(%|\bpercent|\bacceptance\b|\badmitted\b|\brate\b)/i, label: "%/percent/rate" },
  cost: { unitRe: /(\$|\busd\b|\bcad\b|\bdollars?\b|\bfree\b|\bcost\b|\bfee\b|\btuition\b)/i, label: "$/USD/CAD/fee" },
};

const ELIGIBILITY_QUALIFIER_RE = /\b(citizen|citizenship|resident|residency|permanent|eligible|eligibility|international|visa|national|domicile|passport|status|abroad|outside)\b/i;
const FULL_AID_RE = /\b(full|100%|no cost|zero cost|tuition[- ]free|all expenses|full[- ]ride|full[- ]tuition|completely covered)\b/i;
const DATE_FIELDS = new Set(["app_open", "app_deadline", "start", "end"]);

function quoteHasNumber(quote: string, num: number): boolean {
  const s = String(num);
  const qNoComma = quote.replace(/,/g, "");
  if (new RegExp(`(?<!\\d)${s.replace(".", "\\.")}(?!\\d)`).test(qNoComma)) return true;
  return false;
}

function checkEvidenceStrength(field: string, value: unknown, quote: string): string | null {
  const clean = squash(quote);
  if (clean.length < 20) {
    return `quote too short (${clean.length} < 20 chars)`;
  }
  if (/^\d+(?:[.,]\d+)?$/.test(clean)) {
    return "quote cannot be pure digits";
  }
  if (field in NUMERIC_UNIT_RULES) {
    const rule = NUMERIC_UNIT_RULES[field]!;
    if (!rule.unitRe.test(quote)) {
      return `numeric field '${field}' quote missing unit keyword (${rule.label})`;
    }
    if (field === "cost" && typeof value === "object" && value !== null) {
      const c = value as { min?: number; max?: number };
      const hasMin = typeof c.min === "number" && quoteHasNumber(quote, c.min);
      const hasMax = typeof c.max === "number" && quoteHasNumber(quote, c.max);
      if (!hasMin && !hasMax) {
        return `cost quote missing extracted number (${c.min ?? "?"}–${c.max ?? "?"})`;
      }
    } else if (field === "acceptance_rate" && typeof value === "number") {
      const pct = Math.round(value * 1000) / 10;
      const pctInt = Math.round(value * 100);
      if (!quoteHasNumber(quote, value) && !quoteHasNumber(quote, pct) && !quoteHasNumber(quote, pctInt)) {
        return `acceptance_rate quote missing extracted number (${value} / ${pct}%)`;
      }
    } else if (typeof value === "number") {
      if (!quoteHasNumber(quote, value)) {
        return `numeric field '${field}' quote missing extracted number (${value})`;
      }
    }
  }
  if (field === "citizenship" || field === "international_ok") {
    if (!ELIGIBILITY_QUALIFIER_RE.test(quote)) {
      return `${field} quote missing eligibility qualifier (citizen/resident/eligible/international/permanent)`;
    }
  }
  if (field === "aid" && value === "full_for_low_income") {
    if (!FULL_AID_RE.test(quote)) {
      return "aid='full_for_low_income' requires full/100%/no cost in quote (generic financial support is at most partial/need_based)";
    }
  }
  return null;
}

/** Drop any field whose quote is missing, not found in page text, or fails strength rules. */
export function verifyQuotes(
  ex: ExtractedT,
  pageText: string,
): {
  kept: ExtractedT;
  dropped: string[];
  dropped_unquoted: string[];
  dropped_weak_evidence: WeakEvidenceItem[];
} {
  const hay = squash(pageText);
  const kept: Record<string, unknown> = {};
  const dropped_unquoted: string[] = [];
  const dropped_weak_evidence: WeakEvidenceItem[] = [];
  for (const [k, v] of Object.entries(ex)) {
    if (!v || v.value === null || v.value === undefined) continue;
    if (!v.quote || !hay.includes(squash(v.quote))) {
      dropped_unquoted.push(k);
      continue;
    }
    const weakReason = checkEvidenceStrength(k, v.value, v.quote);
    if (weakReason) {
      dropped_weak_evidence.push({ field: k, value: v.value, quote: v.quote, reason: weakReason });
      continue;
    }
    if (DATE_FIELDS.has(k) && typeof v.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.value)) {
      const year = v.value.slice(0, 4);
      if (!v.quote.includes(year)) {
        kept[k] = { ...v, year_inferred: true };
        continue;
      }
    }
    kept[k] = v;
  }
  return {
    kept: kept as ExtractedT,
    dropped: dropped_unquoted,
    dropped_unquoted,
    dropped_weak_evidence,
  };
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
  const grades = normalizeGrades(v("grades") ?? []);
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
  if (v("city")) set("region.city", () => (patch.region = { city: v("city") }));
  if (v("sessions_per_week") !== null) set("sessions_per_week", () => (patch.sessions_per_week = v("sessions_per_week")));
  return { patch, fields };
}

// ---------- targets ----------
interface Target {
  id: string;
  name: string;
  link: string;
  candidate: boolean;
}


// Turn model output like [9, "10", "11-12", "Grade 9 to 12"] into sorted unique grades 6..12.
export function normalizeGrades(raw: Array<number | string>): number[] {
  const out = new Set<number>();
  for (const item of raw) {
    if (typeof item === "number") {
      out.add(item);
      continue;
    }
    const range = item.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})/i);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let g = Math.min(a, b); g <= Math.max(a, b); g++) out.add(g);
      continue;
    }
    for (const m of item.matchAll(/\d{1,2}/g)) out.add(Number(m[0]));
  }
  return [...out].filter((g) => g >= 6 && g <= 12).sort((x, y) => x - y);
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
  const { kept, dropped_unquoted, dropped_weak_evidence } = verifyQuotes(raw, text);
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
    dropped_unquoted,
    dropped_weak_evidence,
  };
  writeFileSync(p("data/review", `${t.id}.json`), JSON.stringify(review, null, 2) + "\n");
  return { fields: fields.length, dropped: dropped_unquoted.length, weak: dropped_weak_evidence.length };
}

async function main() {
  const targets = pickTargets();
  const usage: LlmUsage[] = [];
  const client = new LlmClient({ onUsage: (u: LlmUsage) => usage.push(u) });
  const model = client.modelFor("extract");
  const price = priceFor(client.provider, model);
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
    console.error(`${PROVIDERS[client.provider].keyEnv} is not set (LLM_PROVIDER=${client.provider}). Copy .env.example to .env and fill it in.`);
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
          const notes = [
            r.dropped ? `${r.dropped} unquoted` : "",
            r.weak ? `${r.weak} weak` : "",
          ].filter(Boolean).join(", ");
          console.log(`  ✓ ${t.id}: ${r.fields} field(s) proposed${notes ? ` (${notes} dropped)` : ""}`);
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
