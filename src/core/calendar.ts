/**
 * School-break calendar: deterministic, no AI.
 * A "break" is any run of >= 3 consecutive days with no school.
 *   3–4 days → "Long weekend"; >= 5 days → named break (Winter Break, March Break, Summer…).
 */
import ON_2026_27 from "../../data/calendars/on-2026-27.json" with { type: "json" };


export type Panel = "elementary" | "secondary";
export type BoardType = "public" | "catholic";
export type DayKind = "school" | "weekend" | "holiday" | "break" | "pa" | "summer";

export interface Board {
  id: string;
  name: string;
  short: string;
  type: BoardType;
  cities: string[];
  pa: Record<Panel, string[]>;
  last_day: Record<Panel, string>;
  estimated?: string[];
  note?: string;
  exceptions?: string;
  source: string;
}

export interface RegionCalendar {
  region: string;
  school_year: string;
  checked: string;
  first_day: string;
  year_end: string;
  holidays: Array<{ date: string; name: string; stat: boolean }>;
  breaks: Array<{ start: string; end: string; name: string }>;
  boards: Board[];
}

export interface Day {
  date: string; // YYYY-MM-DD
  kind: DayKind;
  label?: string; // holiday / break / "PA day"
}

export interface Break {
  start: string;
  end: string;
  days: number;
  kind: "long_weekend" | "break";
  name: string; // "Long weekend", "Winter Break", "Summer"…
  reasons: string[]; // e.g. ["Family Day", "PA day"]
  estimated: boolean; // true when a boundary date is not confirmed by the board
}

export const CALENDARS: RegionCalendar[] = [ON_2026_27 as RegionCalendar];
export const BOARDS: Board[] = CALENDARS.flatMap((c) => c.boards);

// ---------- dates (UTC, no time zones) ----------
const toUTC = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const addDays = (iso: string, n: number) => new Date(toUTC(iso) + n * 86_400_000).toISOString().slice(0, 10);
export const dayOfWeek = (iso: string) => new Date(toUTC(iso)).getUTCDay(); // 0 = Sun
export const daysBetween = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / 86_400_000);

// ---------- lookup ----------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export function allCities(): string[] {
  return [...new Set(BOARDS.flatMap((b) => b.cities))].sort();
}

/** Boards serving a city; optionally narrowed to public or Catholic. */
export function boardsForCity(city: string, type?: BoardType): Board[] {
  const c = norm(city);
  if (!c) return [];
  return BOARDS.filter((b) => b.cities.some((x) => norm(x) === c) && (!type || b.type === type));
}

/** Free-text school/board input: matches board short name or full name ("TDSB", "York Catholic"). */
export function boardFromText(text: string): Board | undefined {
  const t = norm(text);
  if (!t) return undefined;
  return BOARDS.find((b) => norm(b.short) === t) ?? BOARDS.find((b) => norm(b.name).includes(t) || t.includes(norm(b.short)));
}

export const getBoard = (id: string) => BOARDS.find((b) => b.id === id);

function calendarFor(board: Board): RegionCalendar {
  return CALENDARS.find((c) => c.boards.includes(board))!;
}

// ---------- classification ----------
export function classifyDay(date: string, board: Board, panel: Panel): Day {
  const cal = calendarFor(board);
  const holiday = cal.holidays.find((h) => h.date === date);
  const brk = cal.breaks.find((b) => date >= b.start && date <= b.end);
  const dow = dayOfWeek(date);
  if (date < cal.first_day || date > board.last_day[panel]) {
    return { date, kind: "summer", label: holiday?.name ?? "Summer" };
  }
  if (holiday) return { date, kind: "holiday", label: holiday.name };
  if (brk) return { date, kind: "break", label: brk.name };
  if (dow === 0 || dow === 6) return { date, kind: "weekend" };
  if (board.pa[panel].includes(date)) return { date, kind: "pa", label: "PA day" };
  return { date, kind: "school" };
}

export function daysInRange(from: string, to: string, board: Board, panel: Panel): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(classifyDay(d, board, panel));
  return out;
}

/** Runs of >= 3 days off. Runs that only partly fall in [from, to] are returned whole. */
export function findBreaks(board: Board, panel: Panel, from: string, to: string): Break[] {
  const cal = calendarFor(board);
  // widen so a break that straddles the window keeps its true length
  const lo = addDays(from, -20);
  const hi = to < cal.year_end ? addDays(to, 20) : to;
  const days = daysInRange(lo, hi, board, panel);
  const breaks: Break[] = [];
  let run: Day[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const start = run[0]!.date;
      const end = run[run.length - 1]!.date;
      if (end >= from && start <= to) breaks.push(describe(run, board, panel));
    }
    run = [];
  };
  for (const d of days) {
    if (d.kind === "school") flush();
    else run.push(d);
  }
  flush();
  return breaks;
}

function describe(run: Day[], board: Board, panel: Panel): Break {
  const start = run[0]!.date;
  const end = run[run.length - 1]!.date;
  const reasons = [...new Set(run.filter((d) => d.label && d.kind !== "summer").map((d) => d.label!))];
  const summer = run.some((d) => d.kind === "summer");
  const named = run.find((d) => d.kind === "break")?.label;
  const kind = run.length >= 5 ? "break" : "long_weekend";
  const name = summer ? "Summer" : kind === "long_weekend" ? "Long weekend" : named ?? "Break";
  const est = new Set(board.estimated ?? []);
  const estimated =
    (summer && est.has(`last_day.${panel}`)) || (summer && est.has("first_day")) || false;
  return { start, end, days: run.length, kind, name, reasons, estimated };
}

/** Next breaks from `today`, soonest first. */
export function upcomingBreaks(board: Board, panel: Panel, today: string, limit = 6): Break[] {
  const cal = calendarFor(board);
  return findBreaks(board, panel, today, cal.year_end)
    .filter((b) => b.end >= today)
    .slice(0, limit);
}

// ---------- own plans → .ics ----------
export interface PlanBlock {
  id: string;
  title: string;
  start: string;
  end: string; // inclusive
  note?: string;
}

export function plansToICS(blocks: PlanBlock[], calName = "Break plans"): string {
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Edmoat//Break Planner//EN", `X-WR-CALNAME:${esc(calName)}`];
  for (const b of blocks) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.id}@breakplanner`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${b.start.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDays(b.end, 1).replace(/-/g, "")}`,
      `SUMMARY:${esc(b.title)}`,
      ...(b.note ? [`DESCRIPTION:${esc(b.note)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
