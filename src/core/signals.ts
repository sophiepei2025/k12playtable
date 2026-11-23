import type { Activity, OrganizerType } from "./schema.js";
import { DECISION_FIELDS } from "./constants.js";

/**
 * Turn raw fields into parent-readable signals.
 * Only verifiable signals: fee, selectivity, outputs, organizer type.
 * No subjective score. Unknown stays unknown.
 */

export type Tier =
  | "free_selective"
  | "paid_selective"
  | "free_open"
  | "paid_open"
  | "unknown";

export const TIER_RANK: Record<Tier, number> = {
  free_selective: 0,
  paid_selective: 1,
  free_open: 2,
  paid_open: 3,
  unknown: 4,
};

export const TIER_LABEL: Record<Tier, string> = {
  free_selective: "Free + selective",
  paid_selective: "Paid + selective",
  free_open: "Free + open",
  paid_open: "Paid + open",
  unknown: "Not yet verified",
};

export const ORGANIZER_NOTE: Record<OrganizerType, string> = {
  company:
    "Run by a company. Strong brand and industry exposure, but many company programs only admit university students, change or end quickly, and may require US citizenship. A big brand does not by itself mean admissions value.",
  nonprofit:
    "Run by a nonprofit or foundation. Usually low cost with long-term, team-based work; check the fee-assistance policy.",
  university_program:
    "Run by a university. Two very different kinds exist: free selective research programs (strongest signal) and paid pre-college courses open to anyone who can pay (an experience, not an endorsement by that university).",
  education_org:
    "Run by an education company or school. Usually paid; value depends on what the student actually produces. Watch for pay-to-publish journals.",
  government:
    "Run by a government agency or national lab. Usually free and selective, but often limited to citizens or permanent residents.",
};

function isFree(a: Activity): boolean | null {
  if (a.fee_type === "free" || a.fee_type === "stipend") return true;
  if (a.fee_type === "paid") return false;
  if (a.cost) return a.cost.max === 0;
  return null;
}

function isSelective(a: Activity): boolean | null {
  if (a.selectivity === null) return null;
  return a.selectivity !== "open";
}

export function tierOf(a: Activity): Tier {
  const free = isFree(a);
  const sel = isSelective(a);
  if (free === null || sel === null) return "unknown";
  if (free && sel) return "free_selective";
  if (!free && sel) return "paid_selective";
  if (free && !sel) return "free_open";
  return "paid_open";
}

export function decisionCompleteness(a: Activity): { filled: number; total: number; missing: string[] } {
  const values: Record<(typeof DECISION_FIELDS)[number], unknown> = {
    cost: a.cost ?? (a.fee_type === "free" || a.fee_type === "stipend" ? a.fee_type : null),
    "dates.app_deadline": a.dates.app_deadline,
    hours_per_week: a.hours_per_week,
    selectivity: a.selectivity,
    "eligibility.international_ok": a.eligibility.international_ok,
  };
  const missing = Object.entries(values)
    .filter(([, v]) => v === null || v === undefined)
    .map(([k]) => k);
  return { filled: DECISION_FIELDS.length - missing.length, total: DECISION_FIELDS.length, missing };
}

export function formatCost(a: Activity): string | null {
  if (a.fee_type === "free") return "Free";
  if (a.fee_type === "stipend") return "Free (pays a stipend)";
  if (!a.cost) return null;
  const { min, max, currency } = a.cost;
  if (max === 0) return "Free";
  const f = (n: number) => `${currency === "CAD" ? "C$" : "US$"}${n.toLocaleString("en-US")}`;
  return min === max ? f(max) : `${f(min)}–${f(max)}`;
}

export interface Signals {
  id: string;
  name: string;
  tier: Tier;
  tier_label: string;
  organizer_type: OrganizerType;
  organizer_note: string;
  cost: string | null;
  aid: Activity["aid"];
  selectivity: Activity["selectivity"];
  acceptance_rate: number | null;
  outputs: Activity["outputs"];
  red_flags: Activity["red_flags"];
  caveats: string[];
  unknown_fields: string[];
  last_verified: string | null;
  sources: string[];
}

export function explainSignals(a: Activity, today = new Date()): Signals {
  const caveats: string[] = [];
  if (a.status === "discontinued") caveats.push(`Discontinued. ${a.status_note ?? ""}`.trim());
  if (a.status === "paused") caveats.push(`Paused. ${a.status_note ?? ""}`.trim());
  if (!a.audience.includes("high_school"))
    caveats.push(`Open to ${a.audience.join(" / ").replace(/_/g, " ")} students only, not high school.`);
  if (a.eligibility.citizenship?.length)
    caveats.push(`Citizenship requirement: ${a.eligibility.citizenship.join(", ")}.`);
  if (a.eligibility.international_ok === false) caveats.push("Not open to international students.");
  if (a.red_flags.includes("pay_to_publish")) caveats.push("Pay-to-publish: publication is bought, not earned.");
  if (a.red_flags.includes("guaranteed_award")) caveats.push("Awards are guaranteed to participants; low signal.");
  if (a.red_flags.includes("vanity_honor_society")) caveats.push("Pay-to-join honor society; low signal.");
  if (a.organizer.is_big_company && a.selectivity === null)
    caveats.push("Big-company brand, but selectivity is not verified yet.");
  if (a.last_verified) {
    const ageDays = (today.getTime() - Date.parse(a.last_verified)) / 86_400_000;
    if (ageDays > 365) caveats.push("Last verified more than 12 months ago; confirm on the official site.");
  } else {
    caveats.push("Key facts not verified yet; confirm on the official site.");
  }
  const tier = tierOf(a);
  return {
    id: a.id,
    name: a.name,
    tier,
    tier_label: TIER_LABEL[tier],
    organizer_type: a.organizer.type,
    organizer_note: ORGANIZER_NOTE[a.organizer.type],
    cost: formatCost(a),
    aid: a.aid,
    selectivity: a.selectivity,
    acceptance_rate: a.acceptance_rate,
    outputs: a.outputs,
    red_flags: a.red_flags,
    caveats,
    unknown_fields: decisionCompleteness(a).missing,
    last_verified: a.last_verified,
    sources: a.sources,
  };
}
