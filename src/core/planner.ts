/**
 * Deterministic scheduling checks. The LLM never does date arithmetic or hour
 * sums; it calls these functions (see SKILL.md rule "禁止").
 *
 * Defaults come from the scheduling skill. S1 and S2 were confirmed by the
 * owner on 2026-11-23; the rest are defaults pending review.
 */

import { LOGISTICS_DEFAULTS, weeklyTravel, type FamilyLogistics } from "./logistics.js";

export const PLANNING_DEFAULTS = {
  /** S1 (confirmed): max extracurricular hours per week during the school term. */
  school_term_max_hours: 10,
  /** S1 (confirmed): max hours per week during summer. */
  summer_max_hours: 40,
  /** S2 (confirmed): no new activity starts during exam weeks or this many days before. */
  exam_buffer_days: 14,
  /** H2: travel buffer before/after a residential program. */
  residential_travel_days: 1,
  /** S6 (pending review): lead time for rec letters / essays. */
  rec_letter_lead_days: 21,
  essay_lead_days: 28,
  /** Reminder offsets before a deadline. */
  reminder_days: [30, 7, 1],
  /** H5 (pending review): data older than this is "unverified". */
  stale_after_days: 365,
  /** Summer window, MM-DD (Ontario schools end late June). */
  summer_start: "06-25",
  summer_end: "08-31",
} as const satisfies Record<string, unknown>;

export interface PlanningConfig {
  school_term_max_hours: number;
  summer_max_hours: number;
  exam_buffer_days: number;
  residential_travel_days: number;
  rec_letter_lead_days: number;
  essay_lead_days: number;
  reminder_days: readonly number[];
  stale_after_days: number;
  summer_start: string;
  summer_end: string;
}

export interface PlanItem {
  id: string; // activity id or a free label for existing commitments ("swim-team")
  name?: string;
  start: string | null; // YYYY-MM-DD
  end: string | null;
  hours_per_week: number | null;
  in_person?: boolean; // occupies a physical location at fixed times
  residential?: boolean; // student lives away (blocks the whole period)
  role?: "primary" | "backup" | "fixed";
  app_deadline?: string | null;
  app_open?: string | null;
  decision?: string | null;
  deposit?: string | null;
  needs_rec_letter?: boolean;
  needs_essay?: boolean;
  /** Logistics (S7/S8): online items cost no travel. */
  online?: boolean;
  commute_minutes_one_way?: number | null;
  sessions_per_week?: number | null;
  session_hours?: number | null;
}

export interface ExamPeriod {
  start: string;
  end: string;
  label?: string;
}

export type ConflictType = "overlap" | "overload" | "travel" | "exam" | "deadline_passed" | "missing_data" | "commute" | "parent_time";

export interface Conflict {
  type: ConflictType;
  items: string[];
  detail: string;
  week_of?: string;
  hours?: number;
  cap?: number;
}

const DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fmt(new Date(toDate(s).getTime() + n * DAY));
const mondayOf = (d: Date) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);

function isSummer(date: Date, cfg: PlanningConfig): boolean {
  const md = fmt(date).slice(5);
  return md >= cfg.summer_start && md <= cfg.summer_end;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export interface WeekLoad {
  week_of: string;
  hours: number; // activity + student commute
  commute_hours: number;
  cap: number;
  season: "term" | "summer";
  parent_hours: number;
  parent_cap: number;
}

export function checkConflicts(
  items: PlanItem[],
  opts: { today?: string; exams?: ExamPeriod[]; config?: Partial<PlanningConfig>; family?: FamilyLogistics } = {},
): { conflicts: Conflict[]; weekly_load: WeekLoad[] } {
  const cfg = { ...PLANNING_DEFAULTS, ...opts.config } as PlanningConfig;
  const fam = opts.family ?? {};
  const transport = fam.transport ?? "parent_drive";
  const maxCommute = fam.max_commute_minutes ?? LOGISTICS_DEFAULTS.max_commute_minutes;
  const parentCap = fam.parent_max_hours_per_week ?? LOGISTICS_DEFAULTS.parent_max_hours_per_week;
  const today = opts.today ?? fmt(new Date());
  const conflicts: Conflict[] = [];
  const label = (i: PlanItem) => i.name ?? i.id;
  const dated = items.filter((i) => i.start && i.end) as Array<PlanItem & { start: string; end: string }>;

  for (const i of items) {
    if (!i.start || !i.end) conflicts.push({ type: "missing_data", items: [i.id], detail: `${label(i)}: program dates unknown; cannot check overlap.` });
    if (i.hours_per_week === null) conflicts.push({ type: "missing_data", items: [i.id], detail: `${label(i)}: hours per week unknown; not counted in weekly load.` });
    if (i.app_deadline && i.app_deadline < today && i.role !== "fixed")
      conflicts.push({ type: "deadline_passed", items: [i.id], detail: `${label(i)}: application deadline ${i.app_deadline} has passed; move to next year's cycle.` });
  }

  // S7 commute + logistics data gaps
  const travel = new Map<string, ReturnType<typeof weeklyTravel>>();
  for (const i of items) {
    const t = weeklyTravel(i, transport);
    travel.set(i.id, t);
    if (i.online || i.residential) continue;
    if (i.commute_minutes_one_way != null && i.commute_minutes_one_way > maxCommute)
      conflicts.push({ type: "commute", items: [i.id], detail: `${label(i)}: about ${i.commute_minutes_one_way} min each way, above the ${maxCommute}-min limit. Look for an online or closer option.` });
    if (t.student_commute_hours === null && i.role !== "fixed")
      conflicts.push({ type: "missing_data", items: [i.id], detail: `${label(i)}: commute or sessions per week unknown; travel time not counted.` });
  }

  // H2 overlap + travel buffer (only physical commitments clash on dates)
  for (let x = 0; x < dated.length; x++) {
    for (let y = x + 1; y < dated.length; y++) {
      const a = dated[x], b = dated[y];
      const physicalA = a.in_person || a.residential;
      const physicalB = b.in_person || b.residential;
      if (a.role === "backup" || b.role === "backup") continue; // backups are alternatives by design
      if (a.residential || b.residential) {
        if (overlaps(a.start, a.end, b.start, b.end) && (physicalA || physicalB)) {
          conflicts.push({ type: "overlap", items: [a.id, b.id], detail: `${label(a)} and ${label(b)} overlap (${a.start}–${a.end} vs ${b.start}–${b.end}); a residential program blocks the whole period.` });
          continue;
        }
        const buf = cfg.residential_travel_days;
        const ra = a.residential ? a : b, other = a.residential ? b : a;
        if (overlaps(addDays(ra.start, -buf), addDays(ra.end, buf), other.start, other.end) && (other.in_person || other.residential))
          conflicts.push({ type: "travel", items: [ra.id, other.id], detail: `Less than ${buf} day of travel time between ${label(ra)} and ${label(other)}.` });
      } else if (physicalA && physicalB && overlaps(a.start, a.end, b.start, b.end)) {
        // Without meeting times we cannot prove a clash; flag it for the family to check.
        conflicts.push({ type: "overlap", items: [a.id, b.id], detail: `${label(a)} and ${label(b)} are both in person and run at the same time (${a.start}–${a.end} vs ${b.start}–${b.end}); check their meeting days and times.` });
      }
    }
  }

  // S2 exams
  for (const ex of opts.exams ?? []) {
    const blockStart = addDays(ex.start, -cfg.exam_buffer_days);
    for (const i of dated) {
      if (i.role === "fixed") continue;
      if (i.start >= blockStart && i.start <= ex.end)
        conflicts.push({ type: "exam", items: [i.id], detail: `${label(i)} starts ${i.start}, inside ${ex.label ?? "exam period"} (${ex.start}–${ex.end}) or the ${cfg.exam_buffer_days}-day lead-up.` });
    }
  }

  // S1 weekly load (activity + student commute) and S8 parent time
  const weeks = new Map<string, { hours: number; commute: number; parent: number; ids: string[]; parentIds: string[] }>();
  for (const i of dated) {
    if (i.role === "backup") continue;
    const t = travel.get(i.id)!;
    const act = i.hours_per_week ?? 0;
    const com = t.student_commute_hours ?? 0;
    const par = t.parent_hours ?? 0;
    if (i.hours_per_week === null && !com && !par) continue;
    for (let d = mondayOf(toDate(i.start)); d <= toDate(i.end); d = new Date(d.getTime() + 7 * DAY)) {
      const k = fmt(d);
      const w = weeks.get(k) ?? { hours: 0, commute: 0, parent: 0, ids: [], parentIds: [] };
      w.hours += act + com;
      w.commute += com;
      w.parent += par;
      w.ids.push(i.id);
      if (par > 0) w.parentIds.push(i.id);
      weeks.set(k, w);
    }
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const loads = [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week_of, w]) => {
      const summer = isSummer(toDate(addDays(week_of, 3)), cfg);
      return {
        week_of,
        hours: r1(w.hours),
        commute_hours: r1(w.commute),
        cap: summer ? cfg.summer_max_hours : cfg.school_term_max_hours,
        season: summer ? ("summer" as const) : ("term" as const),
        parent_hours: r1(w.parent),
        parent_cap: parentCap,
        ids: [...new Set(w.ids)].sort(),
        parentIds: [...new Set(w.parentIds)].sort(),
      };
    });

  // One conflict per run of consecutive over-cap weeks with the same items.
  const runs = (kind: "overload" | "parent_time", over: (w: (typeof loads)[number]) => boolean, ids: (w: (typeof loads)[number]) => string[], val: (w: (typeof loads)[number]) => number, cap: (w: (typeof loads)[number]) => number, text: (span: string, v: number, c: number, w: (typeof loads)[number]) => string) => {
    let run: { from: string; to: string; ids: string[]; v: number; cap: number; w: (typeof loads)[number] } | null = null;
    const flush = () => {
      if (!run) return;
      const span = run.from === run.to ? `Week of ${run.from}` : `Weeks of ${run.from} to ${run.to}`;
      conflicts.push({ type: kind, items: run.ids, week_of: run.from, hours: run.v, cap: run.cap, detail: text(span, run.v, run.cap, run.w) });
      run = null;
    };
    for (const w of loads) {
      const isOver = over(w);
      const contiguous = run && addDays(run.to, 7) === w.week_of && run.ids.join() === ids(w).join() && run.cap === cap(w);
      if (isOver && contiguous && run) {
        run.to = w.week_of;
        run.v = Math.max(run.v, val(w));
      } else {
        flush();
        if (isOver) run = { from: w.week_of, to: w.week_of, ids: ids(w), v: val(w), cap: cap(w), w };
      }
    }
    flush();
  };
  runs("overload", (w) => w.hours > w.cap, (w) => w.ids, (w) => w.hours, (w) => w.cap,
    (span, v, c, w) => `${span}: up to ${v} h/week${w.commute_hours ? ` (incl. ${w.commute_hours} h commute)` : ""}, above the ${w.season === "summer" ? "summer" : "school-term"} cap of ${c} h.`);
  runs("parent_time", (w) => w.parent_hours > w.parent_cap, (w) => w.parentIds, (w) => w.parent_hours, (w) => w.parent_cap,
    (span, v, c) => `${span}: about ${v} h/week of parent driving and pick-up, above the ${c}-hour limit. Consider carpooling, transit, an online option, or a closer program.`);

  const weekly_load: WeekLoad[] = loads.map(({ ids: _a, parentIds: _b, ...rest }) => rest);
  return { conflicts, weekly_load };
}

export type DeadlineType = "app_open" | "prep_start" | "reminder" | "app_deadline" | "decision" | "deposit";

export interface DeadlineEvent {
  id: string;
  name: string;
  type: DeadlineType;
  date: string;
  detail: string;
}

export function getDeadlines(items: PlanItem[], opts: { today?: string; config?: Partial<PlanningConfig> } = {}): DeadlineEvent[] {
  const cfg = { ...PLANNING_DEFAULTS, ...opts.config } as PlanningConfig;
  const today = opts.today ?? fmt(new Date());
  const out: DeadlineEvent[] = [];
  for (const i of items) {
    const name = i.name ?? i.id;
    if (i.app_open) out.push({ id: i.id, name, type: "app_open", date: i.app_open, detail: `${name}: application opens` });
    if (i.app_deadline) {
      const lead = Math.max(i.needs_essay ? cfg.essay_lead_days : 0, i.needs_rec_letter ? cfg.rec_letter_lead_days : 0);
      if (lead) out.push({ id: i.id, name, type: "prep_start", date: addDays(i.app_deadline, -lead), detail: `${name}: start ${i.needs_essay ? "essay" : ""}${i.needs_essay && i.needs_rec_letter ? " and " : ""}${i.needs_rec_letter ? "ask for recommendation letter" : ""} (${lead} days before deadline)` });
      for (const d of cfg.reminder_days)
        out.push({ id: i.id, name, type: "reminder", date: addDays(i.app_deadline, -d), detail: `${name}: deadline in ${d} day${d === 1 ? "" : "s"}` });
      out.push({ id: i.id, name, type: "app_deadline", date: i.app_deadline, detail: `${name}: application deadline` });
    }
    if (i.decision) out.push({ id: i.id, name, type: "decision", date: i.decision, detail: `${name}: decisions released` });
    if (i.deposit) out.push({ id: i.id, name, type: "deposit", date: i.deposit, detail: `${name}: deposit / payment due` });
  }
  return out.filter((e) => e.date >= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Build an iCalendar file (all-day events) from deadline events. */
export function toICS(events: DeadlineEvent[], calName = "Extracurricular deadlines"): string {
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Edmoat//Extracurriculars//EN", `X-WR-CALNAME:${esc(calName)}`];
  for (const e of events) {
    const d = e.date.replace(/-/g, "");
    const next = addDays(e.date, 1).replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}-${e.type}-${d}@edmoat`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc(e.detail)}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
