import activitiesJson from "../../data/activities.json" with { type: "json" };
import type { Activity } from "./schema.js";

/** The built dataset (npm run build:data). Validated at build time. */
export const ACTIVITIES = activitiesJson as unknown as Activity[];
