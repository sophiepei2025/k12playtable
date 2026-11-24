/**
 * Browser entry. Uses the exact same core code as the MCP server and API
 * (search, signals, compare, deadlines), bundled by esbuild into public/app.js.
 */
import type { Activity } from "../core/schema.js";
import { compare, getById, search, type SearchFilters } from "../core/search.js";
import { explainSignals, formatCost, tierOf, TIER_LABEL } from "../core/signals.js";
import { getDeadlines, toICS, type PlanItem } from "../core/planner.js";
import { buildIssueReport } from "../core/issue.js";
import { activityLogistics, CITY_COORDS, type FamilyLogistics } from "../core/logistics.js";
import { isValidEmail, readUtm, waitlistBody, waitlistMailto } from "./waitlist.js";

let ALL: Activity[] = [];
const PAGE = 24;
let limit = PAGE;
const SAVED_KEY = "ecf_saved_v1";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => ($(id) as HTMLInputElement).value;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const meta = (n: string) => document.querySelector<HTMLMetaElement>(`meta[name="${n}"]`)?.content || undefined;
const UTM = readUtm(location.search);

const ORG_LABEL: Record<string, string> = {
  company: "Company",
  nonprofit: "Nonprofit",
  university_program: "University",
  education_org: "Education org",
  government: "Government",
};
const ENV_LABEL: Record<string, string> = { in_person: "In person", hybrid: "Hybrid", online: "Online" };
const SEL_LABEL: Record<string, string> = { open: "Open to all", selective: "Selective", highly_selective: "Highly selective" };

/** Filter controls and their "nothing chosen" value. */
const DEFAULTS: Record<string, string> = {
  grade: "", category: "", environment: "", sort: "",
  q: "", subject: "", country: "", organizer: "", home: "", audience: "high_school",
};
const ADVANCED = ["category", "subject", "organizer", "home", "sort", "audience", "verified"];

// ---------- storage (safe) ----------
function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}
const saved = new Set<string>(loadSaved());
const compareSet = new Set<string>();
const openWhy = new Set<string>();
const openRows = new Set<string>();
function persist() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch {
    /* private mode */
  }
  $("savedCount").textContent = String(saved.size);
  $("savedBtn").hidden = saved.size === 0;
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.style.display = "none"), 3200);
}

// ---------- filters <-> UI ----------
function readFilters(): SearchFilters {
  const f: SearchFilters = { limit };
  if (val("q").trim()) f.q = val("q").trim();
  if (val("audience")) f.audience = [val("audience") as "high_school"];
  if (val("grade")) f.grade = Number(val("grade"));
  if (val("subject")) f.subjects = [val("subject")];
  if (val("category")) f.category = [val("category")];
  if (val("environment")) f.environment = [val("environment") as "online"];
  if (val("organizer")) f.organizer_type = [val("organizer") as "company"];
  if (val("country")) f.country = [val("country") as "CA"];
  if (val("sort")) f.sort = val("sort") as "deadline";
  if (val("home")) f.home_city = val("home");
  if (($("verified") as HTMLInputElement).checked) f.verified_only = true;
  return f;
}

function applyFiltersToUI(f: SearchFilters) {
  const set = (id: string, v: unknown) => (($(id) as HTMLInputElement).value = v === undefined ? "" : String(v));
  set("q", f.q);
  set("audience", f.audience?.[0] ?? "high_school");
  set("grade", f.grade);
  const subj = f.subjects?.[0];
  const opts = [...($("subject") as HTMLSelectElement).options].map((o) => o.value);
  set("subject", subj && opts.includes(subj) ? subj : "");
  set("category", f.category?.[0]);
  set("environment", f.environment?.[0]);
  set("organizer", f.organizer_type?.[0] ?? (f.big_company ? "company" : undefined));
  set("country", f.country?.[0]);
  if (f.sort) set("sort", f.sort);
}

function resetFilters() {
  for (const [id, v] of Object.entries(DEFAULTS)) ($(id) as HTMLInputElement).value = v;
  ($("verified") as HTMLInputElement).checked = false;
  ($("askInput") as HTMLInputElement).value = "";
  $("askHint").textContent = "";
  limit = PAGE;
  render();
}

function filterState() {
  const changed = Object.entries(DEFAULTS).filter(([id, v]) => val(id) !== v).map(([id]) => id);
  if (($("verified") as HTMLInputElement).checked) changed.push("verified");
  const adv = changed.filter((id) => ADVANCED.includes(id)).length;
  return { any: changed.length > 0, adv };
}

function toggleMore(force?: boolean) {
  const open = force ?? $("moreFilters").hidden;
  $("moreFilters").hidden = !open;
  $("moreScrim").hidden = !open;
  $("moreBtn").setAttribute("aria-expanded", String(open));
  if (open && force === undefined) $(matchMedia("(min-width: 601px)").matches ? "category" : "moreClose").focus();
}

// ---------- render ----------
const family = (): FamilyLogistics => ({ home_city: val("home") || undefined });

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function logisticsText(a: Activity): string {
  const lg = activityLogistics(a, family());
  if (lg.est_commute_minutes && lg.est_commute_minutes > 0) return `about ${lg.est_commute_minutes} min each way (estimate)`;
  return lg.label;
}

function whyHtml(a: Activity) {
  const s = explainSignals(a);
  return `<p style="margin:0">${esc(s.organizer_note)}</p>
    ${s.caveats.length ? `<ul>${s.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    <div class="why-meta">Last checked: ${esc(a.last_verified ?? "not yet")} · <button type="button" class="link-btn report-link" data-act="report">Report an error</button></div>`;
}

const STAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/** Keep a trailing "(ACRONYM)" on one line so it never breaks as "(B-A-" / "Y-P)". */
function titleHtml(name: string) {
  const m = name.match(/^(.*?)(\s*\([^)]+\))$/);
  return m ? `${esc(m[1])} <span class="nowrap">${esc(m[2]!.trim())}</span>` : esc(name);
}

function gradeText(a: Activity) {
  if (a.grades.length) {
    const g = [...a.grades].sort((x, y) => x - y);
    return g.length > 1 && g[g.length - 1]! - g[0]! === g.length - 1 ? `Grades ${g[0]}–${g[g.length - 1]}` : `Grade ${g.join(", ")}`;
  }
  return a.audience.includes("high_school") ? "High school" : "University";
}

function rowBody(a: Activity) {
  const why = openWhy.has(a.id);
  const timing = a.timing_text || a.window_text || null;
  const facts: Array<[string, string | null]> = [
    ["Cost", formatCost(a)],
    ["Deadline", fmtDate(a.dates.app_deadline)],
    ["Time", a.hours_per_week !== null ? `${a.hours_per_week} h / week` : null],
    ["Selectivity", a.selectivity ? SEL_LABEL[a.selectivity] : null],
    ["Getting there", logisticsText(a)],
    ["When", timing],
  ];
  const known = facts.filter(([, v]) => v);
  const missing = facts.slice(0, 4).filter(([, v]) => !v).map(([k]) => k.toLowerCase());
  return `<div class="row-body" id="b-${esc(a.id)}">
    ${a.description ? `<p>${esc(a.description)}</p>` : ""}
    ${known.length ? `<dl class="facts">${known.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
    ${missing.length ? `<p class="unconfirmed">Not confirmed yet: ${esc(missing.join(", "))}</p>` : ""}
    ${why ? `<div class="why">${whyHtml(a)}</div>` : ""}
    <div class="row-actions">
      <a class="btn btn-primary" href="${esc(a.link)}" target="_blank" rel="noopener">Official site<span class="sr-only"> for ${esc(a.name)} (opens in new tab)</span></a>
      <button type="button" class="link-btn" data-act="why" aria-expanded="${why}">${why ? "Hide" : "Is it worth it?"}</button>
      <label class="cmp-check"><input type="checkbox" data-act="cmp" ${compareSet.has(a.id) ? "checked" : ""} /> Compare</label>
    </div>
  </div>`;
}

function card(a: Activity) {
  const tier = tierOf(a);
  const open = openRows.has(a.id);
  const isSaved = saved.has(a.id);
  const deadline = fmtDate(a.dates.app_deadline);
  const meta = [
    ORG_LABEL[a.organizer.type],
    gradeText(a),
    a.environment ? ENV_LABEL[a.environment] : null,
    a.region.country === "CA" ? "Canada" : null,
  ].filter(Boolean).map((m) => esc(m));
  if (deadline) meta.push(`<span class="due">Due ${esc(deadline)}</span>`);
  const badge =
    a.status === "discontinued"
      ? `<span class="tier ended">Ended</span>`
      : tier !== "unknown"
        ? `<span class="tier ${tier}">${esc(TIER_LABEL[tier])}</span>`
        : "";
  return `<li class="row${open ? " open" : ""}" data-id="${esc(a.id)}">
    <div class="row-head">
      <button type="button" class="row-toggle" data-act="toggle" aria-expanded="${open}" aria-controls="b-${esc(a.id)}">
        <span class="row-title">${titleHtml(a.name)}${badge}</span>
        <span class="row-meta">${meta.join(" · ")}</span>
      </button>
      <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
      <button type="button" class="save" data-act="save" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from saved" : "Save"}: ${esc(a.name)}">${STAR}</button>
    </div>
    ${open ? rowBody(a) : ""}
  </li>`;
}

function skeleton() {
  $("cardsGrid").setAttribute("aria-busy", "true");
  $("cardsGrid").innerHTML = Array.from({ length: 8 }, () => `<li class="skeleton" aria-hidden="true"></li>`).join("");
}

function render() {
  const f = readFilters();
  const res = search(ALL, f);
  const st = filterState();
  $("resultStats").textContent = res.total === 1 ? "1 program" : `${res.total.toLocaleString("en-US")} programs`;
  $("resetBtn").hidden = !st.any;
  $("moreCount").textContent = st.adv ? String(st.adv) : "";
  $("moreDone").textContent = res.total === 1 ? "Show 1 result" : `Show ${res.total.toLocaleString("en-US")} results`;
  for (const id of ["grade", "environment", "country"]) $(id).classList.toggle("on", val(id) !== "");
  const byId = new Map(ALL.map((a) => [a.id, a]));
  const grid = $("cardsGrid");
  grid.setAttribute("aria-busy", "false");
  if (!res.total) {
    grid.innerHTML = `<li class="state">
      <h3>Nothing matches all of these</h3>
      <p>Remove a filter, or describe what you need in your own words.</p>
      <div class="actions"><button type="button" class="btn btn-primary" data-act="reset">Reset filters</button>
      <button type="button" class="btn" data-act="suggest">Suggest a program</button></div></li>`;
  } else {
    grid.innerHTML =
      res.results.map((s) => card(byId.get(s.id)!)).join("") +
      (res.total > res.results.length
        ? `<li class="more-results"><button type="button" class="btn" data-act="more">Show more</button></li>`
        : "");
  }
  updateTray();
}

function updateTray() {
  const n = compareSet.size;
  $("tray").classList.toggle("show", n > 0);
  $("trayText").textContent = n === 1 ? "1 picked · add another" : `${n} of 3 picked`;
  ($("compareBtn") as HTMLButtonElement).disabled = n < 2;
}

// ---------- modals ----------
let lastFocus: HTMLElement | null = null;
function openModal(title: string, html: string) {
  lastFocus = document.activeElement as HTMLElement | null;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modal").classList.add("open");
  $("modal").setAttribute("aria-hidden", "false");
  $("modalClose").focus();
}
function closeModal() {
  if (!$("modal").classList.contains("open")) return;
  $("modal").classList.remove("open");
  $("modal").setAttribute("aria-hidden", "true");
  lastFocus?.focus();
}
function trapFocus(e: KeyboardEvent) {
  if (!$("modal").classList.contains("open")) return;
  if (e.key === "Escape") return closeModal();
  if (e.key !== "Tab") return;
  const els = [...$("modal").querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")].filter((el) => !el.hasAttribute("disabled"));
  if (!els.length) return;
  const first = els[0]!;
  const last = els[els.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function cell(v: unknown) {
  if (v === "unknown" || v === null || v === undefined) return `<td class="unknown">Not confirmed</td>`;
  const s = Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : String(v).replace(/_/g, " ");
  return `<td>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</td>`;
}

function showCompare() {
  const c = compare(ALL, [...compareSet]);
  const head = `<thead><tr><th scope="col"><span class="sr-only">Field</span></th>${c.activities
    .map((a) => `<th scope="col"><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a></th>`)
    .join("")}</tr></thead>`;
  const rows = c.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${r.values.map(cell).join("")}</tr>`).join("");
  openModal(
    "Compare programs",
    `<div class="cmp-wrap"><table class="cmp">${head}<tbody>${rows}</tbody></table></div>
     <p class="cmp-note">“Not confirmed” means we have not checked it on the official site yet. Drive times are rough estimates.</p>`,
  );
}

function showSaved() {
  const items = [...saved].map((id) => getById(ALL, id)).filter((a): a is Activity => !!a);
  if (!items.length)
    return openModal("Saved programs", `<p>Nothing saved yet. Tap the star on any program to build a shortlist.</p>`);
  const plan: PlanItem[] = items.map((a) => ({
    id: a.id,
    name: a.name,
    start: a.dates.start,
    end: a.dates.end,
    hours_per_week: a.hours_per_week,
    app_open: a.dates.app_open,
    app_deadline: a.dates.app_deadline,
    decision: a.dates.decision,
  }));
  const events = getDeadlines(plan);
  const list = items
    .map((a) => `<li><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a> · deadline ${esc(fmtDate(a.dates.app_deadline) ?? "not confirmed")}</li>`)
    .join("");
  openModal(
    "Saved programs",
    `<ul>${list}</ul>
     <p style="font-size:13px;color:var(--muted)">${events.length} upcoming date${events.length === 1 ? "" : "s"} found. Programs with unconfirmed deadlines are left out.</p>
     <button type="button" class="btn btn-primary" id="icsBtn" ${events.length ? "" : "disabled"}>Add deadlines to calendar (.ics)</button>`,
  );
  $("icsBtn")?.addEventListener("click", () => {
    const blob = new Blob([toICS(events)], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "extracurricular-deadlines.ics";
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function showReport(a: Activity | undefined, suggest = false) {
  openModal(
    suggest ? "Suggest a program" : `Report an error: ${a?.name ?? ""}`,
    `<form id="reportForm" class="form-grid">
      ${
        suggest
          ? `<div class="form-group"><label for="rName">Program name</label><input id="rName" required /></div>
             <div class="form-group"><label for="rLink">Official link</label><input id="rLink" type="url" required placeholder="https://" /></div>`
          : `<div class="form-group"><label for="rField">What is wrong?</label><select id="rField"><option value="dates.app_deadline">Deadline</option><option value="cost">Cost / fee</option><option value="eligibility">Eligibility</option><option value="status">Program ended</option><option value="link">Broken link</option><option value="">Other</option></select></div>`
      }
      <div class="form-group"><label for="rText">${suggest ? "Why is it a good fit?" : "Details and the correct value"}</label><textarea id="rText" rows="3" required></textarea></div>
      <div class="form-group"><label for="rEvidence">Evidence link (official page)</label><input id="rEvidence" type="url" placeholder="https://" /></div>
      <div class="form-group"><button class="btn btn-primary" type="submit">Continue</button></div>
    </form>`,
  );
  $("reportForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (id: string) => (($(id) as HTMLInputElement | null)?.value ?? "").trim();
    const report = buildIssueReport(
      {
        activity_id: suggest ? `new: ${v("rName")}` : a!.id,
        field: suggest ? "new program" : v("rField") || undefined,
        problem: suggest ? `${v("rText")}\nLink: ${v("rLink")}` : v("rText"),
        evidence_url: v("rEvidence") || undefined,
      },
      suggest ? undefined : a,
      { ISSUES_REPO: meta("issues-repo"), FEEDBACK_EMAIL: meta("feedback-email") },
    );
    const target = report.submit_url ?? report.mailto;
    closeModal();
    if (target) {
      window.open(target, "_blank", "noopener");
      toast("Thanks! Finish sending the report in the new tab.");
    } else {
      navigator.clipboard?.writeText(`${report.title}\n\n${report.body}`).catch(() => {});
      toast("Report copied to your clipboard.");
    }
  });
}

// ---------- ask box (Qwen via /api/parse-query) ----------
async function ask(text: string) {
  $("askHint").textContent = "Reading your request…";
  skeleton();
  try {
    const r = await fetch("/api/parse-query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { filters: SearchFilters; source: string };
    resetFilterValues();
    applyFiltersToUI(data.filters);
    $("askHint").textContent = "Filters set from your search. Change any of them below.";
  } catch {
    resetFilterValues();
    applyFiltersToUI({ q: text });
    $("askHint").textContent = "Smart search is unavailable right now, so we searched by keyword.";
  }
  limit = PAGE;
  render();
  $("results").scrollIntoView({ block: "start" });
}

function resetFilterValues() {
  for (const [id, v] of Object.entries(DEFAULTS)) ($(id) as HTMLInputElement).value = v;
}

// ---------- early access ----------
function wireWaitlist() {
  $("earlyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = val("eEmail").trim();
    if (!isValidEmail(email)) {
      $("eError").textContent = "Please enter a valid email address.";
      $("eEmail").setAttribute("aria-invalid", "true");
      $("eEmail").focus();
      return;
    }
    $("eError").textContent = "";
    $("eEmail").removeAttribute("aria-invalid");
    const input = { email, role: val("eRole") };
    const ref = document.referrer ? new URL(document.referrer).hostname : "";
    const link = waitlistMailto(input, UTM, meta("feedback-email"), ref);
    // Hook for analytics once one is added (GA/PostHog read dataLayer).
    const w = window as unknown as { dataLayer?: unknown[] };
    (w.dataLayer ||= []).push({ event: "waitlist_submit", role: input.role, ...UTM });
    if (link) window.location.href = link;
    else navigator.clipboard?.writeText(waitlistBody(input, UTM, ref)).catch(() => {});
    $("earlyForm").innerHTML = `<div class="early-done" role="status">
      <h3>You’re on the list</h3>
      <p>${link ? "Your email app should open with the details. Hit send and we’ll be in touch." : "Thanks! We’ll email you when early access opens."}</p></div>`;
  });
}

// ---------- wire up ----------
async function loadData() {
  skeleton();
  try {
    const r = await fetch("/data/activities.json");
    if (!r.ok) throw new Error(String(r.status));
    ALL = (await r.json()) as Activity[];
    return true;
  } catch {
    $("resultStats").textContent = "Couldn’t load programs";
    $("cardsGrid").setAttribute("aria-busy", "false");
    $("cardsGrid").innerHTML = `<li class="state error" role="alert"><h3>We couldn’t load the program list</h3>
      <p>Check your connection and try again.</p><div class="actions"><button type="button" class="btn btn-primary" data-act="retry">Try again</button></div></li>`;
    return false;
  }
}

async function start() {
  if (!(await loadData())) return;
  const subj = new Map<string, number>();
  for (const a of ALL) for (const s of a.subjects) subj.set(s, (subj.get(s) ?? 0) + 1);
  $("subject").innerHTML += [...subj.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([s]) => s)
    .sort()
    .map((s) => `<option>${esc(s)}</option>`)
    .join("");
  $("home").innerHTML += Object.keys(CITY_COORDS)
    .sort()
    .map((c) => `<option value="${esc(c)}">${esc(c.replace(/\b\w/g, (x) => x.toUpperCase()))}</option>`)
    .join("");
  try {
    const savedHome = localStorage.getItem("ecf_home");
    if (savedHome) ($("home") as HTMLSelectElement).value = savedHome;
  } catch {
    /* ignore */
  }
  // deep link from the planner home page: /browse?q=Google
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    ($("q") as HTMLInputElement).value = q;
    ($("askInput") as HTMLInputElement).value = q;
  }
  render();
}

function init() {
  persist();
  wireWaitlist();
  $("home").addEventListener("change", () => {
    try {
      localStorage.setItem("ecf_home", val("home"));
    } catch {
      /* ignore */
    }
  });
  for (const id of ["q", "audience", "grade", "subject", "category", "environment", "organizer", "country", "home", "sort", "verified"]) {
    $(id).addEventListener(id === "q" ? "input" : "change", () => {
      limit = PAGE;
      render();
    });
  }
  $("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = val("askInput").trim();
    if (t) void ask(t);
    else $("askInput").focus();
  });
  document.querySelectorAll<HTMLButtonElement>(".example").forEach((b) =>
    b.addEventListener("click", () => {
      ($("askInput") as HTMLInputElement).value = b.dataset.q!;
      void ask(b.dataset.q!);
    }),
  );
  $("resetBtn").addEventListener("click", resetFilters);
  $("moreBtn").addEventListener("click", () => toggleMore());
  $("moreClose").addEventListener("click", () => toggleMore(false));
  $("moreScrim").addEventListener("click", () => toggleMore(false));
  $("moreDone").addEventListener("click", () => {
    toggleMore(false);
    $("results").focus();
  });
  $("cardsGrid").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.dataset.act !== "cmp") return;
    const id = box.closest<HTMLElement>(".row")!.dataset.id!;
    if (box.checked) {
      if (compareSet.size >= 3) {
        box.checked = false;
        return toast("You can compare up to 3 programs.");
      }
      compareSet.add(id);
    } else compareSet.delete(id);
    updateTray();
  });
  $("cardsGrid").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "reset") return resetFilters();
    if (act === "suggest") return showReport(undefined, true);
    if (act === "retry") return void start();
    if (act === "more") {
      limit += PAGE;
      return render();
    }
    const row = btn.closest<HTMLElement>(".row")!;
    const id = row.dataset.id!;
    const a = getById(ALL, id)!;
    if (act === "save") {
      if (saved.has(id)) saved.delete(id);
      else saved.add(id);
      persist();
      btn.setAttribute("aria-pressed", String(saved.has(id)));
      btn.setAttribute("aria-label", `${saved.has(id) ? "Remove from saved" : "Save"}: ${a.name}`);
      toast(saved.has(id) ? "Saved" : "Removed from saved");
    } else if (act === "toggle" || act === "why") {
      if (act === "toggle") {
        if (openRows.has(id)) openRows.delete(id);
        else openRows.add(id);
      } else if (openWhy.has(id)) openWhy.delete(id);
      else openWhy.add(id);
      row.outerHTML = card(a);
      const fresh = document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"] [data-act="${act}"]`);
      fresh?.focus();
    } else if (act === "report") showReport(a);
  });
  $("compareBtn").addEventListener("click", showCompare);
  $("clearCmpBtn").addEventListener("click", () => {
    compareSet.clear();
    document.querySelectorAll<HTMLInputElement>('input[data-act="cmp"]').forEach((b) => (b.checked = false));
    updateTray();
  });
  $("savedBtn").addEventListener("click", showSaved);
  $("suggestBtn").addEventListener("click", () => showReport(undefined, true));
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("moreFilters").hidden && !$("modal").classList.contains("open")) toggleMore(false);
    trapFocus(e);
  });
  void start();
}

init();
