import { z } from "zod";

/**
 * Activity record schema (v1).
 *
 * Principle: decision fields are `null` until verified. Unknown is shown as
 * "待核实" in the UI and returned as `null` to agents. Never guess.
 */

import { AUDIENCES, ORGANIZER_TYPES, FEE_TYPES, AID_TYPES, SELECTIVITY, ENVIRONMENTS, STATUS, OUTPUTS, RED_FLAGS } from "./constants.js";
export { AUDIENCES, ORGANIZER_TYPES, FEE_TYPES, AID_TYPES, SELECTIVITY, ENVIRONMENTS, STATUS, OUTPUTS, RED_FLAGS };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const CostSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
  currency: z.enum(["USD", "CAD"]),
  includes: z.array(z.enum(["tuition", "housing", "travel", "materials", "registration"])).default([]),
});

export const DatesSchema = z.object({
  app_open: isoDate.nullable().default(null),
  app_deadline: isoDate.nullable().default(null),
  start: isoDate.nullable().default(null),
  end: isoDate.nullable().default(null),
  decision: isoDate.nullable().default(null),
});

export const EligibilitySchema = z.object({
  grades: z.array(z.number().int().min(6).max(12)).default([]),
  audience: z.array(z.enum(AUDIENCES)).default([]),
  citizenship: z.array(z.string()).nullable().default(null), // e.g. ["US"], ["CA"], null = unknown
  international_ok: z.boolean().nullable().default(null),
  age_min: z.number().int().nullable().default(null),
});

export const RegionSchema = z.object({
  country: z.enum(["US", "CA", "Global"]),
  area: z.string().nullable().default(null), // "East Coast", "Ontario", ...
  city: z.string().nullable().default(null),
  lat: z.number().min(-90).max(90).nullable().default(null),
  lng: z.number().min(-180).max(180).nullable().default(null),
  timezone: z.string().nullable().default(null),
});

export const OrganizerSchema = z.object({
  name: z.string().nullable().default(null),
  type: z.enum(ORGANIZER_TYPES),
  is_big_company: z.boolean().default(false),
});

export const ActivitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  link: z.string().url(),
  logo: z.string().nullable().default(null),
  category: z.string(), // Program | Competition | Academic Research | Community Service | Club
  subjects: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  team: z.enum(["individual", "team", "both"]).nullable().default(null),
  environment: z.enum(ENVIRONMENTS).nullable().default(null),
  commitment: z.enum(["short_term", "long_term"]).nullable().default(null),
  timing_text: z.string().nullable().default(null), // original free text, e.g. "Summer (6 weeks)"
  window_text: z.string().nullable().default(null), // original free text application window
  audience: z.array(z.enum(AUDIENCES)).min(1),
  grades: z.array(z.number().int()).default([]), // [] = not grade-restricted / unknown
  region: RegionSchema,
  organizer: OrganizerSchema,
  status: z.enum(STATUS).default("active"),
  status_note: z.string().nullable().default(null),

  // ---- decision fields (null = unknown / 待核实) ----
  cost: CostSchema.nullable().default(null),
  fee_type: z.enum(FEE_TYPES).nullable().default(null),
  aid: z.enum(AID_TYPES).nullable().default(null),
  hours_per_week: z.number().nonnegative().nullable().default(null),
  total_weeks: z.number().nonnegative().nullable().default(null),
  sessions_per_week: z.number().nonnegative().nullable().default(null), // how many trips per week (logistics)
  dates: DatesSchema.default({}),
  selectivity: z.enum(SELECTIVITY).nullable().default(null),
  acceptance_rate: z.number().min(0).max(1).nullable().default(null),
  eligibility: EligibilitySchema.default({}),
  residential: z.boolean().nullable().default(null),
  outputs: z.array(z.enum(OUTPUTS)).default([]),
  red_flags: z.array(z.enum(RED_FLAGS)).default([]),

  // ---- provenance ----
  last_verified: isoDate.nullable().default(null),
  sources: z.array(z.string().url()).default([]),
  verified_fields: z.array(z.string()).default([]),
});

export type Activity = z.infer<typeof ActivitySchema>;
export type Audience = (typeof AUDIENCES)[number];
export type OrganizerType = (typeof ORGANIZER_TYPES)[number];

/** Fields a human may set through data/overrides/*.json (partial patch per id). */
export const OverridePatchSchema = ActivitySchema.partial().omit({ id: true });
export type OverridePatch = z.infer<typeof OverridePatchSchema>;
