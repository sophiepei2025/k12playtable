/**
 * Human review of extraction results. Nothing reaches the site without this step.
 *
 *   npm run review -- list
 *   npm run review -- show <id>
 *   npm run review -- approve <id> [--fields cost,dates.app_deadline]
 *   npm run review -- reject <id>
 *
 * approve → writes data/overrides/verified.json (existing ids) or data/overrides/added.json
 * (candidates), then rebuilds data/activities.json.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => path.join(ROOT, ...s);
const [cmd, id, ...rest] = process.argv.slice(2);
const fieldsArg = rest.includes("--fields") ? rest[rest.indexOf("--fields") + 1]?.split(",") : undefined;

interface Review {
  id: string;
  name: string;
  url: string;
  candidate: boolean;
  fetched_at: string;
  model: string;
  proposed_patch: Record<string, unknown> & { verified_fields: string[] };
  evidence: Record<string, { value: unknown; quote: string }>;
  dropped_unquoted: string[];
}

const load = (rid: string): Review => {
  const f = p("data/review", `${rid}.json`);
  if (!existsSync(f)) throw new Error(`No review file for ${rid}. Run npm run extract first.`);
  return JSON.parse(readFileSync(f, "utf8"));
};

function filterPatch(r: Review, only?: string[]) {
  if (!only) return r.proposed_patch;
  const keep = new Set(only);
  const patch: Record<string, unknown> = {};
  const fields = r.proposed_patch.verified_fields.filter((f) => keep.has(f));
  for (const f of fields) {
    const [top, sub] = f.split(".");
    const src = r.proposed_patch[top] as Record<string, unknown> | undefined;
    if (sub) {
      patch[top] = { ...((patch[top] as object) ?? {}), [sub]: src?.[sub] };
      if (top === "eligibility" && sub === "grades") patch.grades = r.proposed_patch.grades;
    } else patch[top] = r.proposed_patch[top];
  }
  return { ...patch, last_verified: r.proposed_patch.last_verified, sources: r.proposed_patch.sources, verified_fields: fields };
}

function approve(r: Review) {
  const patch = filterPatch(r, fieldsArg);
  if (r.candidate) {
    const e = r.evidence as Record<string, { value: unknown }>;
    const name = (e.name?.value as string) ?? r.name;
    const record = {
      id: r.id,
      name,
      description: (e.description?.value as string) ?? "",
      link: r.url,
      category: (e.category?.value as string) ?? "Program",
      subjects: (e.subjects?.value as string[]) ?? [],
      environment: (e.environment?.value as string) ?? null,
      audience: ["high_school"],
      region: { country: "CA" },
      organizer: { type: (e.organizer_type?.value as string) ?? "nonprofit", is_big_company: false },
      ...patch,
    };
    const added = JSON.parse(readFileSync(p("data/overrides/added.json"), "utf8")) as Array<{ id: string }>;
    const next = added.filter((a) => a.id !== r.id).concat(record as never);
    writeFileSync(p("data/overrides/added.json"), JSON.stringify(next, null, 2) + "\n");
  } else {
    const verified = JSON.parse(readFileSync(p("data/overrides/verified.json"), "utf8")) as Record<string, Record<string, unknown>>;
    const prev = verified[r.id] ?? {};
    const prevFields = (prev.verified_fields as string[] | undefined) ?? [];
    const prevSources = (prev.sources as string[] | undefined) ?? [];
    verified[r.id] = {
      ...prev,
      ...patch,
      sources: [...new Set([...prevSources, ...((patch.sources as string[]) ?? [])])],
      verified_fields: [...new Set([...prevFields, ...((patch.verified_fields as string[]) ?? [])])],
    };
    writeFileSync(p("data/overrides/verified.json"), JSON.stringify(verified, null, 2) + "\n");
  }
  mkdirSync(p("data/review/approved"), { recursive: true });
  renameSync(p("data/review", `${r.id}.json`), p("data/review/approved", `${r.id}.json`));
  execSync("npx tsx scripts/build-data.ts", { cwd: ROOT, stdio: "inherit" });
  console.log(`approved ${r.id}: ${(patch.verified_fields as string[]).join(", ") || "(no fields)"}`);
}

switch (cmd) {
  case "list": {
    const files = existsSync(p("data/review")) ? readdirSync(p("data/review")).filter((f) => f.endsWith(".json")) : [];
    if (!files.length) console.log("No pending reviews.");
    for (const f of files) {
      const r = JSON.parse(readFileSync(p("data/review", f), "utf8")) as Review;
      console.log(`${r.id.padEnd(42)} ${String(r.proposed_patch.verified_fields.length).padStart(2)} field(s)  ${r.dropped_unquoted.length ? `(${r.dropped_unquoted.length} dropped)` : ""}  ${r.candidate ? "[new]" : ""}`);
    }
    break;
  }
  case "show": {
    const r = load(id);
    console.log(`${r.name}\n${r.url}\nfetched ${r.fetched_at} · ${r.model}\n`);
    for (const [k, v] of Object.entries(r.evidence)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(v.value)}\n  ${"".padEnd(18)} “${v.quote}”`);
    if (r.dropped_unquoted.length) console.log(`\n  dropped (no matching quote on page): ${r.dropped_unquoted.join(", ")}`);
    console.log(`\nproposed patch:\n${JSON.stringify(r.proposed_patch, null, 2)}`);
    break;
  }
  case "approve":
    approve(load(id));
    break;
  case "reject": {
    load(id);
    mkdirSync(p("data/review/rejected"), { recursive: true });
    renameSync(p("data/review", `${id}.json`), p("data/review/rejected", `${id}.json`));
    console.log(`rejected ${id}`);
    break;
  }
  default:
    console.log("usage: npm run review -- list | show <id> | approve <id> [--fields a,b] | reject <id>");
}
