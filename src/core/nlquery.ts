import { z } from "zod";
import type { Activity } from "./schema.js";
import type { SearchFilters } from "./search.js";
import { LlmClient } from "./llm.js";

/**
 * Turn a parent's sentence into SearchFilters (task: nl_search, Qwen flash).
 * The model only fills filters; it never produces activity facts.
 * Falls back to a plain keyword search when no key is configured or the call fails.
 */

const FiltersOut = z.object({
  q: z.string().max(120).optional().nullable(),
  audience: z.array(z.enum(["high_school", "undergraduate", "graduate"])).optional().nullable(),
  grade: z.number().int().min(6).max(12).optional().nullable(),
  subjects: z.array(z.string()).max(6).optional().nullable(),
  category: z.array(z.enum(["Program", "Competition", "Academic Research", "Community Service", "Club"])).optional().nullable(),
  environment: z.array(z.enum(["in_person", "hybrid", "online"])).optional().nullable(),
  commitment: z.enum(["short_term", "long_term"]).optional().nullable(),
  organizer_type: z.array(z.enum(["company", "nonprofit", "university_program", "education_org", "government"])).optional().nullable(),
  big_company: z.boolean().optional().nullable(),
  country: z.array(z.enum(["US", "CA", "Global"])).optional().nullable(),
  fee: z.enum(["free", "paid"]).optional().nullable(),
  max_cost: z.number().nonnegative().optional().nullable(),
  deadline_month: z.number().int().min(1).max(12).optional().nullable(),
  international_ok: z.boolean().optional().nullable(),
  selective_only: z.boolean().optional().nullable(),
});

export function subjectVocabulary(list: Activity[], top = 80): string[] {
  const c = new Map<string, number>();
  for (const a of list) for (const s of a.subjects) c.set(s, (c.get(s) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([s]) => s);
}

const SYSTEM = (subjects: string[], today: string) => `You convert a parent's or counselor's request about extracurricular activities into search filters.
Return ONLY a JSON object with any of these keys (omit keys that the request does not mention):
q (short English keywords, only if needed beyond other filters), audience, grade (9-12), subjects (pick from the list), category, environment (in_person|hybrid|online), commitment (short_term|long_term), organizer_type (company|nonprofit|university_program|education_org|government), big_company (true when they ask for big tech / big company programs), country (US|CA|Global; "near Toronto"/"in Canada" => CA), fee (free|paid), max_cost (number), deadline_month (1-12), international_ok, selective_only.
Today is ${today}. The request may be in English or Chinese. Do not invent constraints that are not stated.
Subjects list: ${subjects.join(", ")}`;

const STOP = new Set("a an and any are as at be best by can child children daughter for from good grade grades high i in is kid kids looking me my need of on or our program programs school some son student students that the to want we what which with year".split(" "));

/**
 * Deterministic fallback when no LLM is available: pull out grade, country,
 * format and type with simple rules; the rest becomes keywords.
 */
export function keywordFilters(text: string): SearchFilters {
  const t = text.toLowerCase();
  const f: SearchFilters = { audience: ["high_school"] };
  const g = t.match(/\bgrade\s*(9|1[0-2])\b|\b(9|1[0-2])(?:th)?\s*grade\b|\bg(9|1[0-2])\b|(九|十|十一|十二)年级/);
  if (g) {
    const zh: Record<string, number> = { 九: 9, 十: 10, 十一: 11, 十二: 12 };
    f.grade = Number(g[1] ?? g[2] ?? g[3]) || zh[g[4]];
  }
  if (/\b(canada|canadian|ontario|toronto)\b|加拿大|多伦多|安省/.test(t)) f.country = ["CA"];
  if (/\b(online|virtual|remote)\b|线上/.test(t)) f.environment = ["online"];
  else if (/\bin[- ]person\b|线下/.test(t)) f.environment = ["in_person", "hybrid"];
  if (/\bcompetitions?\b|\bcontests?\b|\bolympiads?\b|竞赛|比赛/.test(t)) f.category = ["Competition"];
  else if (/\bresearch\b|科研/.test(t)) f.category = ["Academic Research"];
  else if (/\bvolunteer|community service|义工|志愿/.test(t)) f.category = ["Community Service"];
  const words = t
    .replace(/\bgrade\s*\d+|\b\d+(th)?\s*grade|\bg\d+\b/g, " ")
    .replace(/\b(canada|canadian|ontario|toronto|online|virtual|remote|in[- ]person|competitions?|contests?|research)\b/g, " ")
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  if (words.length) f.q = words.join(" ");
  return f;
}

export interface ParseResult {
  filters: SearchFilters;
  source: "llm" | "fallback";
  note?: string;
}

export async function parseQuery(text: string, list: Activity[], client = new LlmClient(), today = new Date().toISOString().slice(0, 10)): Promise<ParseResult> {
  const clean = text.trim().slice(0, 400);
  if (!clean) return { filters: {}, source: "fallback" };
  if (!client.configured) return { filters: keywordFilters(clean), source: "fallback", note: "LLM not configured; used keyword rules." };
  try {
    const out = await client.chatJson("nl_search", SYSTEM(subjectVocabulary(list), today), clean, FiltersOut, {
      maxTokens: 300,
      containsFamilyData: true, // parents describe their child; keep it on an approved provider
    });
    const filters: SearchFilters = {};
    for (const [k, v] of Object.entries(out)) {
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      (filters as Record<string, unknown>)[k] = v;
    }
    filters.audience ??= ["high_school"];
    return { filters, source: "llm" };
  } catch (e) {
    return { filters: keywordFilters(clean), source: "fallback", note: `LLM error, used keyword rules: ${(e as Error).message.slice(0, 120)}` };
  }
}
