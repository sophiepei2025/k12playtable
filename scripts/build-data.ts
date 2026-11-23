/**
 * Build data/activities.json from the raw dataset + human-verified overrides.
 *
 *   data/raw/extracurriculars.json   original 333 records (never edited by hand)
 *   data/overrides/verified.json     { "<id>": { ...patch } }   — human-approved field patches
 *   data/overrides/added.json        [ { ...full activity } ]   — human-approved new records
 *
 * Usage: npm run build:data
 * Fails (exit 1) if any record does not pass the schema.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { PLANNING_SKILL_MD } from "../src/core/planning-rules.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ActivitySchema, OverridePatchSchema, type Activity, type Audience, type OrganizerType } from "../src/core/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => path.join(ROOT, ...s);

interface RawRecord {
  id: string;
  name: string;
  description: string;
  link: string;
  src?: string;
  type: string;
  category: string[];
  grade: string[];
  location: string[];
  environment: string;
  commitment: string;
  timing?: string;
  application_window?: string;
  soloTeam?: string;
  subjects?: string[];
  skill?: string[];
}

const ORG_TYPE: Record<string, OrganizerType> = {
  "Business Corporation": "company",
  "Nonprofit Organization": "nonprofit",
  "Academic Program": "university_program",
  "Educational Institution": "education_org",
  "Government Agency": "government",
};

const ENV: Record<string, Activity["environment"]> = {
  "In Person": "in_person",
  Hybrid: "hybrid",
  "Remote/Virtual": "online",
};

const TEAM: Record<string, Activity["team"]> = {
  "Individual-Based": "individual",
  "Team-Based": "team",
  "Both Individual + Team": "both",
};

const GRADE_NUM: Record<string, number> = { "9th Grade": 9, "10th Grade": 10, "11th Grade": 11, "12th Grade": 12 };

/** Known discontinued programs. Each entry must carry a source. */
const DISCONTINUED: Record<string, { note: string; source: string }> = {
  "google code-in": {
    note: "Google 已于 2019 年后停办 Code-in。",
    source: "https://groups.google.com/g/gci-announce/c/pmo3bvqYBew",
  },
};

/** Known duplicate raw IDs merged into a fuller primary record. */
const MERGED_RAW_IDS = new Set(["us_national_chemistry_olympiad"]);

/** Raw http:// URLs verified to work over https://. */
const HTTPS_UPGRADES: Record<string, string> = {
  "http://www.usaco.org/": "https://www.usaco.org/",
};

const CANADA_HINT = /\b(canada|canadian|ontario|waterloo|toronto|quebec|british columbia|alberta)\b/i;

export function normalizeRaw(r: RawRecord): Activity {
  const grades = r.grade.map((g) => GRADE_NUM[g]).filter((n): n is number => typeof n === "number");
  const audience = new Set<Audience>();
  if (r.grade.includes("All Grades") || grades.length) audience.add("high_school");
  if (r.grade.includes("Undergraduate")) audience.add("undergraduate");
  if (r.grade.includes("Graduate")) audience.add("graduate");
  if (audience.size === 0) audience.add("high_school");

  const loc = r.location.map((l) => l.replace("Global Worldwide", "Global/Worldwide"));
  let country: "US" | "CA" | "Global" = loc.includes("Global/Worldwide") ? "Global" : "US";
  let area: string | null =
    loc.find((l) => /East Coast/.test(l)) ? "East Coast" :
    loc.find((l) => /West Coast/.test(l)) ? "West Coast" :
    loc.find((l) => /Mid ?West/.test(l)) ? "Midwest" : null;
  if (CANADA_HINT.test(r.name)) {
    country = "CA";
    area = null;
  }

  const name = r.name.trim();
  const link = HTTPS_UPGRADES[r.link.trim()] ?? r.link.trim();
  const disc = DISCONTINUED[name.toLowerCase()];
  const orgType = ORG_TYPE[r.type] ?? "education_org";
  const category = (r.category[0] ?? "Program").replace("Comnpetition", "Competition");
  const logo = r.src && /^https?:\/\//.test(r.src) ? r.src : null;

  return ActivitySchema.parse({
    id: r.id,
    name,
    description: r.description.trim(),
    link,
    logo,
    category,
    subjects: r.subjects ?? [],
    skills: r.skill ?? [],
    team: r.soloTeam ? TEAM[r.soloTeam] ?? null : null,
    environment: ENV[r.environment] ?? null,
    commitment: r.commitment === "Long-Term" ? "long_term" : r.commitment === "Short-Term" ? "short_term" : null,
    timing_text: r.timing?.trim() || null,
    window_text: r.application_window?.trim() || null,
    audience: [...audience],
    grades,
    region: { country, area },
    // Heuristic: in this dataset "Business Corporation" means a large company sponsor.
    organizer: { type: orgType, is_big_company: orgType === "company" },
    status: disc ? "discontinued" : "active",
    status_note: disc?.note ?? null,
    eligibility: { grades, audience: [...audience] },
    sources: disc ? [link, disc.source] : [link],
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge a patch into a record (objects merged, arrays/scalars replaced). */
export function applyPatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? applyPatch(out[k] as Record<string, unknown>, v) : v;
  }
  return out as T;
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export function build(): Activity[] {
  const raw = readJson<RawRecord[]>(p("data/raw/extracurriculars.json"), []);
  const verified = readJson<Record<string, unknown>>(p("data/overrides/verified.json"), {});
  const added = readJson<unknown[]>(p("data/overrides/added.json"), []);

  const errors: string[] = [];
  const byId = new Map<string, Activity>();
  for (const r of raw) {
    if (MERGED_RAW_IDS.has(r.id)) continue;
    try {
      byId.set(r.id, normalizeRaw(r));
    } catch (e) {
      errors.push(`raw ${r.id}: ${(e as Error).message}`);
    }
  }
  for (const rec of added) {
    const parsed = ActivitySchema.safeParse(rec);
    if (!parsed.success) errors.push(`added ${(rec as { id?: string }).id}: ${parsed.error.message}`);
    else if (byId.has(parsed.data.id)) errors.push(`added ${parsed.data.id}: duplicate id`);
    else byId.set(parsed.data.id, parsed.data);
  }
  for (const [id, patch] of Object.entries(verified)) {
    if (id.startsWith("_")) continue; // comments
    const base = byId.get(id);
    if (!base) {
      errors.push(`override ${id}: unknown id`);
      continue;
    }
    const p1 = OverridePatchSchema.safeParse(patch);
    if (!p1.success) {
      errors.push(`override ${id}: ${p1.error.message}`);
      continue;
    }
    const merged = ActivitySchema.safeParse(applyPatch(base, patch as Record<string, unknown>));
    if (!merged.success) errors.push(`override ${id}: ${merged.error.message}`);
    else byId.set(id, merged.data);
  }
  if (errors.length) {
    console.error(`build-data: ${errors.length} error(s)\n` + errors.join("\n"));
    process.exit(1);
  }
  return [...byId.values()];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const list = build();
  const json = JSON.stringify(list, null, 1) + "\n";
  writeFileSync(p("data/activities.json"), json);
  mkdirSync(p("public/data"), { recursive: true });
  writeFileSync(p("public/data/activities.json"), JSON.stringify(list)); // minified copy for the web page
  mkdirSync(p("skills/extracurricular-schedule-planner"), { recursive: true });
  writeFileSync(p("skills/extracurricular-schedule-planner/SKILL.md"), PLANNING_SKILL_MD);
  const verifiedCount = list.filter((a) => a.last_verified).length;
  console.log(`build-data: wrote ${list.length} activities (${verifiedCount} with verified fields) → data/activities.json`);
}
