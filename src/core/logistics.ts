import type { Activity } from "./schema.js";

/**
 * Family logistics cost: format (online vs in person), distance from home,
 * and the parent's driving / pick-up time. All deterministic; every
 * distance-based number is an estimate and is flagged as such.
 *
 * Defaults S7/S8 are pending owner confirmation.
 */

export type Transport = "parent_drive" | "transit" | "self";
export type LogisticsBand = "none" | "low" | "medium" | "high" | "travel" | "unknown";
export type Priority = "signal" | "convenience";

export const LOGISTICS_DEFAULTS = {
  /** S7 (pending): max one-way commute for a recurring activity, minutes. */
  max_commute_minutes: 45,
  /** S8 (pending): max parent driving/pick-up time per week, hours. */
  parent_max_hours_per_week: 4,
  /** "low" band upper bound, one-way minutes. */
  low_commute_minutes: 20,
  /** Beyond this distance it is a trip, not a commute. */
  travel_km: 150,
  /** Commute estimate: straight-line km × road factor; first city_km at city speed, rest at highway speed; plus overhead (parking, walking). */
  road_factor: 1.3,
  city_km: 15,
  city_speed_kmh: 30,
  highway_speed_kmh: 80,
  overhead_minutes: 10,
} as const;

export interface FamilyLogistics {
  home_city?: string;
  home?: { lat: number; lng: number } | null;
  transport?: Transport; // default parent_drive
  max_commute_minutes?: number;
  parent_max_hours_per_week?: number;
}

/** City centres for distance estimates (approximate). Keys are lower-case. */
export const CITY_COORDS: Record<string, [number, number]> = {
  toronto: [43.6532, -79.3832],
  "north york": [43.7615, -79.4111],
  scarborough: [43.7731, -79.2578],
  etobicoke: [43.6205, -79.5132],
  markham: [43.8561, -79.337],
  "richmond hill": [43.8828, -79.4403],
  vaughan: [43.8361, -79.4983],
  mississauga: [43.589, -79.6441],
  brampton: [43.7315, -79.7624],
  oakville: [43.4675, -79.6877],
  oshawa: [43.8971, -78.8658],
  waterloo: [43.4643, -80.5204],
  kitchener: [43.4516, -80.4925],
  hamilton: [43.2557, -79.8711],
  "london, on": [42.9849, -81.2453],
  kingston: [44.2312, -76.486],
  ottawa: [45.4215, -75.6972],
  montreal: [45.5017, -73.5673],
  vancouver: [49.2827, -123.1207],
  calgary: [51.0447, -114.0719],
  edmonton: [53.5461, -113.4938],
  "new york": [40.7128, -74.006],
  boston: [42.3601, -71.0589],
  cambridge: [42.3736, -71.1097],
  pittsburgh: [40.4406, -79.9959],
  chicago: [41.8781, -87.6298],
  "san francisco": [37.7749, -122.4194],
  "palo alto": [37.4419, -122.143],
  seattle: [47.6062, -122.3321],
  "los angeles": [34.0522, -118.2437],
};

export const BAND_RANK: Record<LogisticsBand, number> = { none: 0, low: 1, medium: 2, unknown: 3, high: 4, travel: 5 };

export const BAND_LABEL: Record<LogisticsBand, string> = {
  none: "Online, no commute",
  low: "Close to home",
  medium: "Moderate commute",
  high: "Long commute",
  travel: "Requires travel / stay away",
  unknown: "Location not verified",
};

export function coordsFor(city?: string | null): [number, number] | null {
  if (!city) return null;
  return CITY_COORDS[city.trim().toLowerCase()] ?? null;
}

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function estimateCommuteMinutes(km: number): number {
  const d = LOGISTICS_DEFAULTS;
  const road = km * d.road_factor;
  const city = Math.min(road, d.city_km);
  const highway = Math.max(road - d.city_km, 0);
  return Math.round((city / d.city_speed_kmh) * 60 + (highway / d.highway_speed_kmh) * 60 + d.overhead_minutes);
}

function homeCoords(f: FamilyLogistics): [number, number] | null {
  if (f.home) return [f.home.lat, f.home.lng];
  return coordsFor(f.home_city);
}

function activityCoords(a: Activity): [number, number] | null {
  if (a.region.lat !== null && a.region.lng !== null) return [a.region.lat, a.region.lng];
  return coordsFor(a.region.city);
}

export interface ActivityLogistics {
  band: LogisticsBand;
  label: string;
  distance_km: number | null;
  est_commute_minutes: number | null;
  estimated: boolean;
  note: string | null;
}

/** Logistics band of an activity for a given family (search ranking + cards). */
export function activityLogistics(a: Activity, f: FamilyLogistics = {}): ActivityLogistics {
  const max = f.max_commute_minutes ?? LOGISTICS_DEFAULTS.max_commute_minutes;
  const out = (band: LogisticsBand, extra: Partial<ActivityLogistics> = {}): ActivityLogistics => ({
    band,
    label: BAND_LABEL[band],
    distance_km: null,
    est_commute_minutes: null,
    estimated: false,
    note: null,
    ...extra,
  });
  if (a.environment === "online") return out("none", { est_commute_minutes: 0 });
  if (a.residential) return out("travel", { note: "Residential: one trip there and back instead of a weekly commute." });
  const home = homeCoords(f);
  const place = activityCoords(a);
  if (!home || !place) {
    return out("unknown", { note: !home ? "Add your home city to estimate the commute." : "Program location not verified yet." });
  }
  const km = Math.round(haversineKm(home, place));
  if (km > LOGISTICS_DEFAULTS.travel_km) return out("travel", { distance_km: km, estimated: true, note: `About ${km} km away: a trip, not a commute.` });
  const min = estimateCommuteMinutes(km);
  let band: LogisticsBand = min <= LOGISTICS_DEFAULTS.low_commute_minutes ? "low" : min <= max ? "medium" : "high";
  // Hybrid programs need fewer trips: one band easier.
  if (a.environment === "hybrid" && band !== "low") band = band === "high" ? "medium" : "low";
  return out(band, { distance_km: km, est_commute_minutes: min, estimated: true, note: `Estimated ${min} min one way (${km} km, straight-line estimate).` });
}

/** Weekly time cost of one plan item. */
export function weeklyTravel(
  item: { online?: boolean; residential?: boolean; commute_minutes_one_way?: number | null; sessions_per_week?: number | null; session_hours?: number | null; hours_per_week: number | null },
  transport: Transport = "parent_drive",
): { student_commute_hours: number | null; parent_hours: number | null; sessions: number | null; missing: string[] } {
  if (item.online) return { student_commute_hours: 0, parent_hours: 0, sessions: 0, missing: [] };
  if (item.residential) return { student_commute_hours: 0, parent_hours: 0, sessions: 0, missing: [] };
  const missing: string[] = [];
  const oneWay = item.commute_minutes_one_way ?? null;
  if (oneWay === null) missing.push("commute_minutes_one_way");
  const sessions = item.sessions_per_week ?? (item.hours_per_week !== null ? 1 : null);
  if (item.sessions_per_week == null) missing.push("sessions_per_week");
  if (oneWay === null || sessions === null) return { student_commute_hours: null, parent_hours: null, sessions, missing };
  const sessionH = item.session_hours ?? (item.hours_per_week !== null && sessions > 0 ? item.hours_per_week / sessions : 0);
  const student = (sessions * 2 * oneWay) / 60;
  // Parent: either two round trips (drop off, go home, come back) or one round trip and wait — whichever is shorter.
  const perSessionParentMin = Math.min(4 * oneWay, 2 * oneWay + sessionH * 60);
  const parent = transport === "parent_drive" ? (sessions * perSessionParentMin) / 60 : 0;
  return { student_commute_hours: round1(student), parent_hours: round1(parent), sessions, missing };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
