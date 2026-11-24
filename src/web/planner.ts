/** Break Planner home: board calendar, upcoming breaks, the family's own plans, and (paid) picks per break. */
import {
  allCities, boardsForCity, addDays, classifyDay, dayOfWeek, upcomingBreaks, plansToICS,
  type Board, type Break, type Panel, type PlanBlock,
} from "../core/calendar.js";
import { picksForBreak, bigCompanyWall, GOALS, type Goal } from "../core/breakplan.js";
import type { Activity } from "../core/schema.js";

interface Setup { city: string; type: "public" | "catholic"; grade: number }
interface Plan extends PlanBlock { breakName?: string; link?: string }

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
};

/** Local preview of the paid picks: /?pro=1 (remembered). */
const PRO = (() => {
  const p = new URLSearchParams(location.search).get("pro");
  if (p !== null) store.set("bp.pro", p === "1");
  return store.get("bp.pro", false);
})();

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const TODAY = new URLSearchParams(location.search).get("today") ?? localToday();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmt = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const fmtRange = (a: string, b: string) => (a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`);
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let setup: Setup | null = store.get<Setup | null>("bp.setup", null);
let plans: Plan[] = store.get<Plan[]>("bp.plans", []);
let monthOffset = 0;
let ACTIVITIES: Activity[] | null = null;

const panelFor = (grade: number): Panel => (grade >= 9 ? "secondary" : "elementary");
const gradeLabel = (g: number) => (g === 0 ? "Kindergarten" : `Grade ${g}`);
function boardFor(s: Setup): Board | undefined {
  return boardsForCity(s.city, s.type)[0];
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout((toast as unknown as { h?: number }).h);
  (toast as unknown as { h?: number }).h = window.setTimeout(() => (t.style.display = "none"), 2400);
}

async function loadActivities(): Promise<Activity[]> {
  if (ACTIVITIES) return ACTIVITIES;
  const r = await fetch("/data/activities.json");
  if (!r.ok) throw new Error(String(r.status));
  ACTIVITIES = (await r.json()) as Activity[];
  return ACTIVITIES;
}

// ---------- setup ----------
function fillSetupForm() {
  $("cityList").innerHTML = allCities().map((c) => `<option value="${esc(c)}"></option>`).join("");
  if (!setup) return;
  ($("city") as HTMLInputElement).value = setup.city;
  ($("schoolType") as HTMLSelectElement).value = setup.type;
  ($("gradeSel") as HTMLSelectElement).value = String(setup.grade);
}

function onSetup(e: Event) {
  e.preventDefault();
  const city = ($("city") as HTMLInputElement).value.trim();
  const next: Setup = {
    city,
    type: ($("schoolType") as HTMLSelectElement).value as Setup["type"],
    grade: Number(($("gradeSel") as HTMLSelectElement).value),
  };
  const err = $("setupError");
  if (!city) {
    err.textContent = "Enter your city.";
    $("city").setAttribute("aria-invalid", "true");
    return $("city").focus();
  }
  if (!boardFor(next)) {
    err.textContent = `We don't have ${city} yet. We cover the GTA and Waterloo Region — try a nearby city like Toronto, Markham or Mississauga.`;
    $("city").setAttribute("aria-invalid", "true");
    return $("city").focus();
  }
  err.textContent = "";
  $("city").removeAttribute("aria-invalid");
  setup = next;
  store.set("bp.setup", setup);
  monthOffset = 0;
  renderCalendar();
  $("calendar").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  $("calendar").focus({ preventScroll: true });
}

// ---------- calendar ----------
function renderCalendar() {
  if (!setup) return;
  const board = boardFor(setup);
  if (!board) return;
  const panel = panelFor(setup.grade);
  $("calendar").hidden = false;
  document.body.classList.add("has-calendar");
  $("calTitle").textContent = `${board.short} · ${gradeLabel(setup.grade)}`;
  const notes = [
    `${board.name}, ${panel} schools, 2026–27.`,
    board.note ?? "",
    board.exceptions ?? "",
  ].filter(Boolean);
  $("calNote").innerHTML = `${esc(notes.join(" "))} <a href="${esc(board.source)}" target="_blank" rel="noopener">Board calendar</a>`;

  // upcoming breaks
  const breaks = upcomingBreaks(board, panel, TODAY, 6);
  $("breaks").innerHTML = breaks.length
    ? breaks.map((b, i) => breakRow(b, i)).join("")
    : `<li class="empty">No more breaks in the 2026–27 school year.</li>`;

  renderMonths(board, panel);
  renderPlans();
}

function breakRow(b: Break, i: number) {
  const planned = plans.filter((p) => p.start <= b.end && p.end >= b.start).length;
  const why = b.reasons.filter((r) => r !== b.name).join(" · ");
  const now = b.start <= TODAY && b.end >= TODAY;
  return `<li class="break${b.kind === "break" ? " big" : ""}" data-i="${i}">
    <div class="break-main">
      <span class="break-name">${esc(b.name)}${now ? ` <span class="pill now">Now</span>` : ""}${b.estimated ? ` <span class="pill est">Estimated — confirm with school</span>` : ""}</span>
      <span class="break-meta">${esc(fmtRange(b.start, b.end))} · ${b.days} days${why ? ` · ${esc(why)}` : ""}</span>
    </div>
    <button type="button" class="btn${i === 0 ? " btn-primary" : ""}" data-plan="${i}">${planned ? `${planned} planned` : "Plan it"}</button>
  </li>`;
}

function renderMonths(board: Board, panel: Panel) {
  const base = new Date(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1 + monthOffset, 1);
  const count = matchMedia("(max-width: 600px)").matches ? 1 : 3;
  const html: string[] = [];
  const firstLabel: string[] = [];
  for (let m = 0; m < count; m++) {
    const d = new Date(base.getFullYear(), base.getMonth() + m, 1);
    const y = d.getFullYear();
    const mo = d.getMonth();
    firstLabel.push(`${MONTHS_LONG[mo]} ${y}`);
    const first = `${y}-${String(mo + 1).padStart(2, "0")}-01`;
    const len = new Date(y, mo + 1, 0).getDate();
    const cells: string[] = WEEKDAY.map((w) => `<div class="dow" aria-hidden="true">${w[0]}</div>`);
    for (let k = 0; k < dayOfWeek(first); k++) cells.push(`<div class="day pad" aria-hidden="true"></div>`);
    for (let n = 0; n < len; n++) {
      const iso = addDays(first, n);
      const d0 = classifyDay(iso, board, panel);
      const mine = plans.filter((p) => p.start <= iso && p.end >= iso);
      const label = d0.label && d0.kind !== "weekend" ? d0.label : "";
      const title = [fmt(iso), label, ...mine.map((p) => p.title)].filter(Boolean).join(" — ");
      cells.push(`<div class="day k-${d0.kind}${iso === TODAY ? " today" : ""}${mine.length ? " has-plan" : ""}" title="${esc(title)}" aria-label="${esc(title)}">
        <span class="num">${n + 1}</span>${label && d0.kind !== "summer" ? `<span class="lbl">${esc(label)}</span>` : ""}${mine.length ? `<span class="dot" aria-hidden="true"></span>` : ""}
      </div>`);
    }
    html.push(`<section class="month" aria-label="${MONTHS_LONG[mo]} ${y}"><h4>${MONTHS_LONG[mo]} ${y}</h4><div class="grid">${cells.join("")}</div></section>`);
  }
  $("months").innerHTML = html.join("");
  $("monthRange").textContent = count === 1 ? firstLabel[0]! : `${firstLabel[0]} – ${firstLabel[count - 1]}`;
  ($("prevMonth") as HTMLButtonElement).disabled = monthOffset <= -2;
  ($("nextMonth") as HTMLButtonElement).disabled = monthOffset >= 9;
}

// ---------- plans ----------
function renderPlans() {
  const sorted = [...plans].sort((a, b) => a.start.localeCompare(b.start));
  $("plans").innerHTML = sorted.length
    ? sorted
        .map(
          (p) => `<li class="plan" data-id="${esc(p.id)}">
        <div><span class="plan-title">${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</span>
        <span class="plan-meta">${esc(fmtRange(p.start, p.end))}${p.breakName ? ` · ${esc(p.breakName)}` : ""}${p.note ? ` · ${esc(p.note)}` : ""}</span></div>
        <button type="button" class="link-btn danger" data-del="${esc(p.id)}" aria-label="Remove ${esc(p.title)}">Remove</button></li>`,
        )
        .join("")
    : `<li class="empty">Nothing planned yet. Pick a break above and add what your child will do.</li>`;
  $("icsBtn").hidden = plans.length === 0;
}

function savePlans(): boolean {
  if (store.set("bp.plans", plans)) return true;
  toast("Couldn’t save on this device. Check that the browser allows site storage.");
  return false;
}

function addPlan(p: Omit<Plan, "id">) {
  const plan: Plan = { ...p, id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  plans.push(plan);
  if (!savePlans()) {
    plans.pop();
    return false;
  }
  renderCalendar();
  return true;
}

// ---------- plan a break (modal) ----------
let lastFocus: HTMLElement | null = null;
function openModal(title: string, body: string) {
  lastFocus = document.activeElement as HTMLElement;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  $("modal").classList.add("open");
  $("modal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  ($("modalBody").querySelector("input, select, button") as HTMLElement | null)?.focus();
}
function closeModal() {
  $("modal").classList.remove("open");
  $("modal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  lastFocus?.focus();
}

function planBreak(b: Break) {
  const goal: Goal = store.get<Goal>("bp.goal", "undecided");
  const minD = b.start < TODAY ? TODAY : b.start;
  openModal(
    `${b.name} · ${fmtRange(b.start, b.end)}`,
    `<form class="add-form" id="addForm" novalidate>
      <h3 class="sub">Add your own plan</h3>
      <div class="field"><label for="pTitle">What</label><input id="pTitle" required placeholder="e.g. Coding camp, visit grandparents" /></div>
      <div class="two">
        <div class="field"><label for="pStart">From</label><input id="pStart" type="date" value="${minD}" min="${b.start}" max="${b.end}" /></div>
        <div class="field"><label for="pEnd">To</label><input id="pEnd" type="date" value="${b.end}" min="${b.start}" max="${b.end}" /></div>
      </div>
      <p class="error" id="addError" role="alert"></p>
      <button class="btn btn-primary" type="submit">Add to calendar</button>
    </form>
    <div class="picks">
      <div class="picks-head"><h3 class="sub">Fill this break with programs</h3>
        <label class="goal"><span>Interested in</span><select id="goalSel">${Object.entries(GOALS)
          .map(([k, g]) => `<option value="${k}"${k === goal ? " selected" : ""}>${esc(g.label)}</option>`)
          .join("")}</select></label></div>
      <div id="picksBody"></div>
    </div>`,
  );
  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = ($("pTitle") as HTMLInputElement).value.trim();
    const start = ($("pStart") as HTMLInputElement).value;
    const end = ($("pEnd") as HTMLInputElement).value;
    const err = $("addError");
    if (!title) {
      err.textContent = "Add a short name for the plan.";
      return $("pTitle").focus();
    }
    if (!start || !end || start > end) {
      err.textContent = "The end date must be on or after the start date.";
      return $("pEnd").focus();
    }
    if (addPlan({ title, start, end, breakName: b.name })) {
      closeModal();
      toast(`Added “${title}”`);
    }
  });
  $("addForm").addEventListener("input", () => ($("addError").textContent = ""));
  $("goalSel").addEventListener("change", () => {
    store.set("bp.goal", ($("goalSel") as HTMLSelectElement).value);
    void renderPicks(b);
  });
  void renderPicks(b);
}

async function renderPicks(b: Break) {
  const box = $("picksBody");
  if (!PRO) {
    box.innerHTML = `<div class="locked">
      <p><b>Personal picks for each break</b> are part of the paid plan: programs matched to your child's grade and interests, with application deadlines added to your calendar.</p>
      <a class="btn btn-primary" href="/browse#early-access">Get early access</a>
      <a class="link-btn" href="/browse">Or browse all programs free</a></div>`;
    return;
  }
  box.innerHTML = `<p class="muted">Loading programs…</p>`;
  let list: Activity[];
  try {
    list = await loadActivities();
  } catch {
    box.innerHTML = `<p class="error">Couldn’t load programs. <button type="button" class="link-btn" id="picksRetry">Try again</button></p>`;
    $("picksRetry").addEventListener("click", () => void renderPicks(b));
    return;
  }
  const goal = ($("goalSel") as HTMLSelectElement).value as Goal;
  if (setup && setup.grade < 9) {
    box.innerHTML = `<p class="muted">Programs in our list are for high school students (grades 9–12) for now.</p>`;
    return;
  }
  const picks = picksForBreak(list, { brk: b, grade: setup?.grade, goal, limit: 6 });
  box.innerHTML = picks.length
    ? `<ul class="pick-list">${picks
        .map(
          (p) => `<li><div><a href="${esc(p.activity.link)}" target="_blank" rel="noopener" class="pick-name">${esc(p.activity.name)}</a>
          <span class="pick-meta">${esc(p.fitLabel)}</span></div>
          <button type="button" class="btn" data-pick="${esc(p.activity.id)}">Add</button></li>`,
        )
        .join("")}</ul><p class="muted small">Preview of the paid picks. Check dates and costs on each official site.</p>`
    : `<p class="muted">Nothing that fits this break yet. Try another interest.</p>`;
  box.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const a = list.find((x) => x.id === btn.dataset.pick)!;
      const start = b.start < TODAY ? TODAY : b.start;
      if (addPlan({ title: a.name, start, end: b.end, breakName: b.name, link: a.link, note: "check dates" })) {
        btn.textContent = "Added";
        btn.disabled = true;
      }
    }),
  );
}

// ---------- big-company wall ----------
async function renderWall() {
  try {
    const wall = bigCompanyWall(await loadActivities()).slice(0, 14);
    if (!wall.length) return;
    $("wallNames").innerHTML = wall
      .map((w) => `<a href="/browse?q=${encodeURIComponent(w.company)}">${esc(w.company)}</a>`)
      .join(", ");
    $("wall").hidden = false;
  } catch {
    /* the wall is optional */
  }
}

// ---------- wire up ----------
function init() {
  fillSetupForm();
  $("setupForm").addEventListener("submit", onSetup);
  $("city").addEventListener("input", () => {
    $("setupError").textContent = "";
    $("city").removeAttribute("aria-invalid");
  });
  $("changeBtn").addEventListener("click", () => {
    document.body.classList.remove("has-calendar");
    $("setup").scrollIntoView();
    $("city").focus();
  });
  $("breaks").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-plan]");
    if (!btn || !setup) return;
    const board = boardFor(setup)!;
    const b = upcomingBreaks(board, panelFor(setup.grade), TODAY, 6)[Number(btn.dataset.plan)];
    if (b) planBreak(b);
  });
  $("plans").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-del]");
    if (!btn) return;
    const removed = plans.find((p) => p.id === btn.dataset.del);
    plans = plans.filter((p) => p.id !== btn.dataset.del);
    savePlans();
    renderCalendar();
    if (removed) toast(`Removed “${removed.title}”`);
  });
  $("icsBtn").addEventListener("click", () => {
    const blob = new Blob([plansToICS(plans)], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "break-plans.ics";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("prevMonth").addEventListener("click", () => {
    monthOffset -= 1;
    renderCalendar();
  });
  $("nextMonth").addEventListener("click", () => {
    monthOffset += 1;
    renderCalendar();
  });
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("modal").classList.contains("open")) closeModal();
  });
  let w = innerWidth;
  addEventListener("resize", () => {
    if ((w <= 600) !== (innerWidth <= 600)) renderCalendar();
    w = innerWidth;
  });
  if (setup && boardFor(setup)) renderCalendar();
  void renderWall();
}

init();
