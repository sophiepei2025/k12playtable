/** Enum constants shared by server and browser code (no runtime deps). */
export const AUDIENCES = ["high_school", "undergraduate", "graduate"] as const;
export const ORGANIZER_TYPES = [
  "company",
  "nonprofit",
  "university_program",
  "education_org",
  "government",
] as const;
export const FEE_TYPES = ["free", "paid", "stipend"] as const;
export const AID_TYPES = ["none", "need_based", "full_for_low_income", "merit"] as const;
export const SELECTIVITY = ["open", "selective", "highly_selective"] as const;
export const ENVIRONMENTS = ["in_person", "hybrid", "online"] as const;
export const STATUS = ["active", "paused", "discontinued"] as const;
export const OUTPUTS = [
  "award",
  "paper",
  "college_credit",
  "rec_letter",
  "portfolio",
  "certificate",
  "stipend",
] as const;
export const RED_FLAGS = ["pay_to_publish", "guaranteed_award", "vanity_honor_society"] as const;


/** The five decision fields the plan commits to filling first. */
export const DECISION_FIELDS = [
  "cost",
  "dates.app_deadline",
  "hours_per_week",
  "selectivity",
  "eligibility.international_ok",
] as const;
