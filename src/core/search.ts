import type { Activity, Audience, OrganizerType } from "./schema.js";
import { TIER_RANK, decisionCompleteness, formatCost, tierOf } from "./signals.js";
import { activityLogistics, BAND_RANK, type FamilyLogistics, type LogisticsBand } from "./logistics.js";

/** Filters shared by the web page, the public API and the MCP tool. All optional. */
export interface SearchFilters {
  q?: string;
  audience?: Audience[];
  grade?: number; // 9–12
  subjects?: string[]; // any-match, case-insensitive substring
  category?: string[]; // Program | Competition | Academic Research | Community Service | Club
  environment?: Array<"in_person" | "hybrid" | "online">;
  commitment?: "short_term" | "long_term";
  organizer_type?: OrganizerType[];
  big_company?: boolean;
  country?: Array<"US" | "CA" | "Global">;
  fee?: "free" | "paid";
  max_cost?: number; // only activities with known cost ≤ this (any currency, see note)
  deadline_month?: number; // 1–12, verified app_deadline in that month
  deadline_after?: string; // YYYY-MM-DD, verified deadline on/after
  international_ok?: boolean;
  selective_only?: boolean;
  verified_only?: boolean; // at least one decision field verified
  include_discontinued?: boolean;
  /** Family logistics: home location enables commute estimates. */
  home_city?: string;
  home?: { lat: number; lng: number };
  /** Hide programs whose estimated one-way commute is above this (unknown kept). */
  max_commute_minutes?: number;
  /** signal = value tier first, logistics breaks ties (default). convenience = logistics first. */
  sort?: "relevance" | "signal" | "convenience" | "deadline" | "name";
  limit?: number;
  offset?: number;
}

export interface ActivitySummary {
  id: string;
  name: string;
  category: string;
  organizer_type: OrganizerType;
  big_company: boolean;
  country: string;
  environment: Activity["environment"];
  audience: Audience[];
  grades: number[];
  cost: string | null;
  fee_type: Activity["fee_type"];
  app_deadline: string | null;
  hours_per_week: number | null;
  selectivity: Activity["selectivity"];
  international_ok: boolean | null;
  tier: string;
  logistics: LogisticsBand;
  est_commute_minutes: number | null;
  verified: string; // "2/5"
  last_verified: string | null;
  status: Activity["status"];
  link: string;
}

export interface SearchResult {
  total: number;
  offset: number;
  limit: number;
  results: ActivitySummary[];
}

const famOf = (f: SearchFilters): FamilyLogistics => ({ home_city: f.home_city, home: f.home, max_commute_minutes: f.max_commute_minutes });

export function summarize(a: Activity, fam: FamilyLogistics = {}): ActivitySummary {
  const c = decisionCompleteness(a);
  const lg = activityLogistics(a, fam);
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    organizer_type: a.organizer.type,
    big_company: a.organizer.is_big_company,
    country: a.region.country,
    environment: a.environment,
    audience: a.audience,
    grades: a.grades,
    cost: formatCost(a),
    fee_type: a.fee_type,
    app_deadline: a.dates.app_deadline,
    hours_per_week: a.hours_per_week,
    selectivity: a.selectivity,
    international_ok: a.eligibility.international_ok,
    tier: tierOf(a),
    logistics: lg.band,
    est_commute_minutes: lg.est_commute_minutes,
    verified: `${c.filled}/${c.total}`,
    last_verified: a.last_verified,
    status: a.status,
    link: a.link,
  };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD");

export function tokenize(q: string): string[] {
  return norm(q)
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((t) => t.length > 1 || /\p{Script=Han}/u.test(t));
}

/** Simple weighted keyword score. Name ×3, subjects/category ×2, description ×1. */
export function relevance(a: Activity, tokens: string[]): number {
  if (!tokens.length) return 0;
  const name = norm(a.name);
  const tags = norm([...a.subjects, a.category, a.organizer.type.replace(/_/g, " ")].join(" "));
  const desc = norm(a.description);
  let score = 0;
  for (const t of tokens) {
    if (name.includes(t)) score += 3;
    if (tags.includes(t)) score += 2;
    if (desc.includes(t)) score += 1;
  }
  return score;
}

export function matches(a: Activity, f: SearchFilters): boolean {
  if (!f.include_discontinued && a.status === "discontinued") return false;
  if (f.audience?.length && !f.audience.some((x) => a.audience.includes(x))) return false;
  if (f.grade !== undefined && a.audience.includes("high_school") && a.grades.length && !a.grades.includes(f.grade))
    return false;
  if (f.grade !== undefined && !a.audience.includes("high_school")) return false;
  if (f.subjects?.length) {
    const subj = a.subjects.map(norm);
    if (!f.subjects.some((s) => subj.some((x) => x.includes(norm(s))))) return false;
  }
  if (f.category?.length && !f.category.map(norm).includes(norm(a.category))) return false;
  if (f.environment?.length && (!a.environment || !f.environment.includes(a.environment))) return false;
  if (f.commitment && a.commitment !== f.commitment) return false;
  if (f.organizer_type?.length && !f.organizer_type.includes(a.organizer.type)) return false;
  if (f.big_company !== undefined && a.organizer.is_big_company !== f.big_company) return false;
  if (f.country?.length && !f.country.includes(a.region.country)) return false;
  if (f.fee === "free") {
    const free = a.fee_type === "free" || a.fee_type === "stipend" || a.cost?.max === 0;
    if (!free) return false;
  }
  if (f.fee === "paid" && !(a.fee_type === "paid" || (a.cost && a.cost.max > 0))) return false;
  if (f.max_cost !== undefined) {
    const known = a.cost ? a.cost.min : a.fee_type === "free" || a.fee_type === "stipend" ? 0 : null;
    if (known === null || known > f.max_cost) return false;
  }
  if (f.deadline_month !== undefined) {
    const d = a.dates.app_deadline;
    if (!d || Number(d.slice(5, 7)) !== f.deadline_month) return false;
  }
  if (f.deadline_after) {
    const d = a.dates.app_deadline;
    if (!d || d < f.deadline_after) return false;
  }
  if (f.international_ok !== undefined && a.eligibility.international_ok !== f.international_ok) return false;
  if (f.selective_only && !(a.selectivity === "selective" || a.selectivity === "highly_selective")) return false;
  if (f.verified_only && decisionCompleteness(a).filled === 0 && !a.last_verified) return false;
  if (f.max_commute_minutes !== undefined) {
    const lg = activityLogistics(a, famOf(f));
    if (lg.est_commute_minutes !== null && lg.est_commute_minutes > f.max_commute_minutes) return false;
    // Too far to commute and not residential: excluded. Residential programs are trips by design and stay.
    if (lg.band === "travel" && lg.distance_km !== null && !a.residential) return false;
  }
  if (f.q) {
    const tokens = tokenize(f.q);
    if (tokens.length && relevance(a, tokens) === 0) return false;
  }
  return true;
}

export function search(list: Activity[], f: SearchFilters = {}): SearchResult {
  const limit = Math.min(Math.max(f.limit ?? 20, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const tokens = f.q ? tokenize(f.q) : [];
  const sort = f.sort ?? (tokens.length ? "relevance" : "signal");

  const hits = list.filter((a) => matches(a, f));
  const fam = famOf(f);
  const key = (a: Activity) => ({
    band: BAND_RANK[activityLogistics(a, fam).band],
    rel: relevance(a, tokens),
    tier: TIER_RANK[tierOf(a)],
    filled: decisionCompleteness(a).filled,
    deadline: a.dates.app_deadline ?? "9999-99-99",
  });
  const keyed = hits.map((a) => ({ a, k: key(a) }));
  keyed.sort((x, y) => {
    if (sort === "relevance" && y.k.rel !== x.k.rel) return y.k.rel - x.k.rel;
    if (sort === "deadline" && x.k.deadline !== y.k.deadline) return x.k.deadline < y.k.deadline ? -1 : 1;
    if (sort === "name") return x.a.name.localeCompare(y.a.name);
    if (sort === "convenience" && x.k.band !== y.k.band) return x.k.band - y.k.band;
    if (x.k.tier !== y.k.tier) return x.k.tier - y.k.tier;
    if (x.k.band !== y.k.band) return x.k.band - y.k.band;
    if (y.k.filled !== x.k.filled) return y.k.filled - x.k.filled;
    if (y.k.rel !== x.k.rel) return y.k.rel - x.k.rel;
    return x.a.name.localeCompare(y.a.name);
  });
  return {
    total: keyed.length,
    offset,
    limit,
    results: keyed.slice(offset, offset + limit).map(({ a }) => summarize(a, fam)),
  };
}

export function getById(list: Activity[], id: string): Activity | undefined {
  return list.find((a) => a.id === id);
}

/** Side-by-side comparison of up to 3 activities. */
export function compare(list: Activity[], ids: string[]) {
  const found = ids.slice(0, 3).map((id) => ({ id, a: getById(list, id) }));
  const missing = found.filter((x) => !x.a).map((x) => x.id);
  const items = found.filter((x): x is { id: string; a: Activity } => !!x.a).map((x) => x.a);
  const row = (label: string, fn: (a: Activity) => unknown) => ({
    label,
    values: items.map((a) => {
      const v = fn(a);
      return v === null || v === undefined || (Array.isArray(v) && v.length === 0) ? "unknown" : v;
    }),
  });
  return {
    activities: items.map((a) => ({ id: a.id, name: a.name, link: a.link })),
    missing_ids: missing,
    rows: [
      row("Tier", (a) => tierOf(a)),
      row("Cost", (a) => formatCost(a)),
      row("Financial aid", (a) => a.aid),
      row("Application deadline", (a) => a.dates.app_deadline),
      row("Program dates", (a) => (a.dates.start ? `${a.dates.start} → ${a.dates.end ?? "?"}` : null)),
      row("Hours per week", (a) => a.hours_per_week),
      row("Format", (a) => a.environment),
      row("Logistics", (a) => activityLogistics(a).label),
      row("Residential", (a) => a.residential),
      row("Selectivity", (a) => a.selectivity),
      row("International students", (a) => a.eligibility.international_ok),
      row("Grades", (a) => (a.grades.length ? a.grades.join(", ") : a.audience.join(", "))),
      row("Organizer type", (a) => a.organizer.type),
      row("Outputs", (a) => a.outputs),
      row("Last verified", (a) => a.last_verified),
    ],
  };
}
