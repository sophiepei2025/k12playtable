/**
 * Profile data quality of data/raw/extracurriculars.json and data/activities.json.
 * Usage: npx tsx scripts/profile-data.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Activity } from "../src/core/schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => path.join(ROOT, ...s);

interface RawRecord {
  id: string;
  name: string;
  link: string;
  category?: string[];
  location?: string[];
  cost?: unknown;
}

const raw = JSON.parse(readFileSync(p("data/raw/extracurriculars.json"), "utf8")) as RawRecord[];
const built = JSON.parse(readFileSync(p("data/activities.json"), "utf8")) as Activity[];

function findDups<T extends { id: string; name: string; link: string }>(
  items: T[],
  keyFn: (x: T) => string,
) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return [...map.entries()].filter(([, v]) => v.length > 1);
}

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const normLink = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").trim();

const rawDupNames = findDups(raw, (x) => normName(x.name));
const rawDupLinks = findDups(raw, (x) => normLink(x.link));
const builtDupNames = findDups(built, (x) => normName(x.name));
const builtDupLinks = findDups(built, (x) => normLink(x.link));

const rawComnpetition = raw.filter((r) => (r.category ?? []).includes("Comnpetition")).map((r) => r.id);
const builtComnpetition = built.filter((a) => a.category === "Comnpetition").map((a) => a.id);

const rawGlobalNoSlash = raw.filter((r) => (r.location ?? []).includes("Global Worldwide")).map((r) => r.id);
const rawMidWestNoSpace = raw.filter((r) => (r.location ?? []).includes("Mid West(USA)")).map((r) => r.id);

const builtAreaIssues = built.filter((a) => a.region.area && /Mid West\(|Global Worldwide/.test(a.region.area)).map((a) => a.id);

const rawHttpLinks = raw.filter((r) => r.link.startsWith("http://")).map((r) => ({ id: r.id, link: r.link }));
const builtHttpLinks = built.filter((a) => a.link.startsWith("http://")).map((a) => ({ id: a.id, link: a.link }));

const builtCostNull = built.filter((a) => a.cost === null).length;
const builtFeeTypeNull = built.filter((a) => a.fee_type === null).length;
const builtFeeTypeFree = built.filter((a) => a.fee_type === "free").length;
const builtVerified = built.filter((a) => a.last_verified !== null).length;
const builtDiscontinued = built.filter((a) => a.status === "discontinued").length;

console.log("=== DATA QUALITY PROFILE ===");
console.log(`Raw count:   ${raw.length}`);
console.log(`Built count: ${built.length} (verified: ${builtVerified}, discontinued: ${builtDiscontinued})`);
console.log("\n-- Duplicates --");
console.log(`Raw duplicate names (${rawDupNames.length}):`, rawDupNames.map(([k, v]) => `${k} -> [${v.map((x) => x.id).join(", ")}]`));
console.log(`Raw duplicate links (${rawDupLinks.length}):`, rawDupLinks.map(([k, v]) => `${k} -> [${v.map((x) => x.id).join(", ")}]`));
console.log(`Built duplicate names (${builtDupNames.length}):`, builtDupNames.map(([k, v]) => `${k} -> [${v.map((x) => x.id).join(", ")}]`));
console.log(`Built duplicate links (${builtDupLinks.length}):`, builtDupLinks.map(([k, v]) => `${k} -> [${v.map((x) => x.id).join(", ")}]`));
console.log("\n-- Spelling / Tags --");
console.log(`Raw 'Comnpetition': ${rawComnpetition.length} (${rawComnpetition.join(", ")})`);
console.log(`Built 'Comnpetition': ${builtComnpetition.length}`);
console.log(`Raw 'Global Worldwide': ${rawGlobalNoSlash.length} (${rawGlobalNoSlash.join(", ")})`);
console.log(`Raw 'Mid West(USA)': ${rawMidWestNoSpace.length} (${rawMidWestNoSpace.join(", ")})`);
console.log(`Built area issues: ${builtAreaIssues.length}`);
console.log("\n-- Links --");
console.log(`Raw http:// links (${rawHttpLinks.length}):`, rawHttpLinks);
console.log(`Built http:// links (${builtHttpLinks.length}):`, builtHttpLinks);
console.log("\n-- Cost & Fee Type --");
console.log(`Built cost === null: ${builtCostNull} / ${built.length}`);
console.log(`Built fee_type === null: ${builtFeeTypeNull} / ${built.length}, fee_type === 'free': ${builtFeeTypeFree}`);
