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

let ALL: Activity[] = [];
const SAVED_KEY = "ecf_saved_v1";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const meta = (n: string) => document.querySelector<HTMLMetaElement>(`meta[name="${n}"]`)?.content || undefined;

const ORG_LABEL: Record<string, string> = {
  company: "Company",
  nonprofit: "Nonprofit",
  university_program: "University",
  education_org: "Education org",
  government: "Government",
};
const ENV_LABEL: Record<string, string> = { in_person: "In person", hybrid: "Hybrid", online: "Online" };
const SEL_LABEL: Record<string, string> = { open: "Open to all", selective: "Selective", highly_selective: "Highly selective" };

// ---------- storage (safe) ----------
function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}
let saved = new Set<string>(loadSaved());
const compareSet = new Set<string>();
const openWhy = new Set<string>();
function persist() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch {
    /* private mode */
  }
  $("savedCount").textContent = String(saved.size);
}

function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout((window as unknown as { __t?: number }).__t);
  (window as unknown as { __t?: number }).__t = window.setTimeout(() => (el.style.display = "none"), 3000);
}

// ---------- filters <-> UI ----------
function readFilters(): SearchFilters {
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  const f: SearchFilters = { limit: 60 };
  if (v("q").trim()) f.q = v("q").trim();
  if (v("audience")) f.audience = [v("audience") as "high_school"];
  if (v("grade")) f.grade = Number(v("grade"));
  if (v("subject")) f.subjects = [v("subject")];
  if (v("category")) f.category = [v("category")];
  if (v("environment")) f.environment = [v("environment") as "online"];
  if (v("organizer")) f.organizer_type = [v("organizer") as "company"];
  if (v("country")) f.country = [v("country") as "CA"];
  if (v("sort")) f.sort = v("sort") as "deadline";
  if (v("home")) f.home_city = v("home");
  if (($("verified") as HTMLInputElement).checked) f.verified_only = true;
  return f;
}

function applyFiltersToUI(f: SearchFilters) {
  const set = (id: string, val: unknown) => (($(id) as HTMLInputElement).value = val === undefined ? "" : String(val));
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
}

// ---------- render ----------
function fact(label: string, value: string | null) {
  return value
    ? `<div class="fact"><b>${label}</b>${esc(value)}</div>`
    : `<div class="fact unknown"><b>${label}</b>Unverified</div>`;
}

function whyHtml(a: Activity) {
  const s = explainSignals(a);
  return `<div>${esc(s.organizer_note)}</div>${s.caveats.length ? `<ul>${s.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}`;
}

const family = (): FamilyLogistics => ({ home_city: ($("home") as HTMLSelectElement).value || undefined });

function card(a: Activity) {
  const tier = tierOf(a);
  const lg = activityLogistics(a, family());
  const isSaved = saved.has(a.id);
  const inCmp = compareSet.has(a.id);
  const hours = a.hours_per_week !== null ? `${a.hours_per_week} h/week` : null;
  return `<div class="card" data-id="${esc(a.id)}">
    <div>
      <div class="tags" style="margin:0 0 8px">
        <span class="tier ${tier}">${esc(TIER_LABEL[tier])}</span>
        <span class="tag">${esc(ORG_LABEL[a.organizer.type])}</span>
        ${a.environment ? `<span class="tag env">${esc(ENV_LABEL[a.environment])}</span>` : ""}
        ${a.region.country === "CA" ? `<span class="tag">Canada</span>` : ""}
        ${a.status === "discontinued" ? `<span class="tag status-ended">Discontinued</span>` : ""}
        ${!a.audience.includes("high_school") ? `<span class="tag time">University only</span>` : ""}
      </div>
      <h3 class="card-title">${esc(a.name)}</h3>
      <p class="card-desc">${esc(a.description)}</p>
      <div class="facts">
        ${fact("Cost", formatCost(a))}
        ${fact("Deadline", a.dates.app_deadline)}
        ${fact("Time", hours)}
        ${fact("Selectivity", a.selectivity ? SEL_LABEL[a.selectivity] : null)}
      </div>
      <div class="why ${openWhy.has(a.id) ? "open" : ""}" id="why-${esc(a.id)}">${openWhy.has(a.id) ? whyHtml(a) : ""}</div>
    </div>
    <div>
      <div class="card-meta">
        <div><strong>Getting there:</strong> ${esc(lg.est_commute_minutes && lg.est_commute_minutes > 0 ? `~${lg.est_commute_minutes} min one way (estimate)` : lg.label)}</div>
        ${a.timing_text ? `<div><strong>When:</strong> ${esc(a.timing_text)}</div>` : ""}
        ${a.window_text && !a.dates.app_deadline ? `<div><strong>Applications:</strong> ${esc(a.window_text)}</div>` : ""}
        <div><strong>Grades:</strong> ${esc(a.grades.length ? a.grades.join(", ") : a.audience.join(", ").replace(/_/g, " "))}</div>
        <div><strong>Last verified:</strong> ${esc(a.last_verified ?? "not yet")}</div>
      </div>
      <div class="card-actions">
        <a href="${esc(a.link)}" target="_blank" rel="noopener">Official site &rarr;</a>
        <span>
          <button class="btn-mini" data-act="why">Is it worth it?</button>
          <button class="btn-mini ${isSaved ? "on" : ""}" data-act="save">${isSaved ? "Saved" : "Save"}</button>
          <button class="btn-mini ${inCmp ? "on" : ""}" data-act="cmp">Compare</button>
          <button class="btn-mini" data-act="report">Report</button>
        </span>
      </div>
    </div>
  </div>`;
}

function render() {
  const f = readFilters();
  const res = search(ALL, f);
  $("resultStats").textContent = `${res.total} of ${ALL.length} programs`;
  const byId = new Map(ALL.map((a) => [a.id, a]));
  $("cardsGrid").innerHTML =
    res.results.map((s) => card(byId.get(s.id)!)).join("") +
    (res.total > res.results.length
      ? `<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--muted);font-size:13px">Showing the first ${res.results.length}. Narrow the filters to see more.</div>`
      : "");
  updateTray();
}

function updateTray() {
  const n = compareSet.size;
  $("tray").classList.toggle("show", n > 0);
  $("trayText").textContent = `${n} selected to compare (max 3)`;
}

// ---------- modals ----------
function openModal(title: string, html: string) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modal").classList.add("open");
  $("modal").setAttribute("aria-hidden", "false");
}
function closeModal() {
  $("modal").classList.remove("open");
  $("modal").setAttribute("aria-hidden", "true");
}

function showCompare() {
  const c = compare(ALL, [...compareSet]);
  const head = `<tr><th></th>${c.activities.map((a) => `<th><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a></th>`).join("")}</tr>`;
  const rows = c.rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th>${r.values
          .map((v) => `<td class="${v === "unknown" ? "unknown" : ""}">${esc(Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : String(v).replace(/_/g, " "))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  openModal("Compare programs", `<table class="cmp">${head}${rows}</table>`);
}

function showSaved() {
  const items = [...saved].map((id) => getById(ALL, id)).filter((a): a is Activity => !!a);
  if (!items.length) return openModal("Saved programs", `<p>Nothing saved yet. Use “Save” on any program.</p>`);
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
    .map((a) => `<li><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a> — deadline ${esc(a.dates.app_deadline ?? "unverified")}</li>`)
    .join("");
  openModal(
    "Saved programs",
    `<ul>${list}</ul>
     <p style="font-size:13px;color:var(--muted)">${events.length} upcoming dates found for your saved programs. Programs with unverified deadlines are not included.</p>
     <button class="btn btn-primary" id="icsBtn" ${events.length ? "" : "disabled"}>Download deadlines (.ics)</button>`,
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
    suggest ? "Suggest a program" : `Report a problem: ${a?.name ?? ""}`,
    `<form id="reportForm" class="form-grid">
      ${suggest ? `<div class="form-group full"><label>Program name</label><input id="rName" required /></div><div class="form-group full"><label>Official link</label><input id="rLink" type="url" required placeholder="https://" /></div>` : `<div class="form-group full"><label>What is wrong?</label><select id="rField"><option value="dates.app_deadline">Deadline</option><option value="cost">Cost / fee</option><option value="eligibility">Eligibility</option><option value="status">Program ended</option><option value="link">Broken link</option><option value="">Other</option></select></div>`}
      <div class="form-group full"><label>${suggest ? "Why is it a good fit?" : "Details and the correct value"}</label><textarea id="rText" rows="3" required></textarea></div>
      <div class="form-group full"><label>Evidence link (official page)</label><input id="rEvidence" type="url" placeholder="https://" /></div>
      <div class="form-group full"><button class="btn btn-primary" type="submit">Continue</button></div>
    </form>`,
  );
  $("reportForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = (id: string) => (($(id) as HTMLInputElement | null)?.value ?? "").trim();
    const report = buildIssueReport(
      {
        activity_id: suggest ? `new: ${val("rName")}` : a!.id,
        field: suggest ? "new program" : val("rField") || undefined,
        problem: suggest ? `${val("rText")}\nLink: ${val("rLink")}` : val("rText"),
        evidence_url: val("rEvidence") || undefined,
      },
      suggest ? undefined : a,
      { ISSUES_REPO: meta("issues-repo"), FEEDBACK_EMAIL: meta("feedback-email") },
    );
    const target = report.submit_url ?? report.mailto;
    if (target) {
      window.open(target, "_blank", "noopener");
      closeModal();
      toast("Thanks! Finish sending the report in the new tab.");
    } else {
      navigator.clipboard?.writeText(`${report.title}\n\n${report.body}`).catch(() => {});
      toast("Report copied to clipboard.");
      closeModal();
    }
  });
}

// ---------- ask box (Qwen via /api/parse-query) ----------
async function ask(text: string) {
  $("askHint").textContent = "Thinking…";
  try {
    const r = await fetch("/api/parse-query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { filters: SearchFilters; source: string };
    applyFiltersToUI(data.filters);
    const chips = Object.entries(data.filters)
      .filter(([k]) => !["limit", "offset"].includes(k))
      .map(([k, v]) => `<span class="chip">${esc(k.replace(/_/g, " "))}: ${esc(Array.isArray(v) ? v.join(", ") : v)}</span>`)
      .join("");
    $("appliedChips").innerHTML = chips;
    $("askHint").textContent = data.source === "llm" ? "Here is how we read your request. Adjust any filter below." : "Searched by keyword.";
  } catch {
    applyFiltersToUI({ q: text });
    $("askHint").textContent = "Smart search is unavailable here, so we searched by keyword.";
  }
  render();
}

// ---------- wire up ----------
async function init() {
  persist();
  try {
    const r = await fetch("/data/activities.json");
    ALL = (await r.json()) as Activity[];
  } catch {
    $("resultStats").textContent = "Could not load data. Serve this folder over HTTP (npx serve public).";
    return;
  }
  $("totalBadge").textContent = `${ALL.length} programs`;
  const subj = new Map<string, number>();
  for (const a of ALL) for (const s of a.subjects) subj.set(s, (subj.get(s) ?? 0) + 1);
  $("subject").innerHTML += [...subj.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([s]) => s)
    .sort()
    .map((s) => `<option>${esc(s)}</option>`)
    .join("");

  const cities = Object.keys(CITY_COORDS).sort();
  $("home").innerHTML += cities.map((c) => `<option value="${esc(c)}">${esc(c.replace(/\b\w/g, (x) => x.toUpperCase()))}</option>`).join("");
  try {
    const savedHome = localStorage.getItem("ecf_home");
    if (savedHome) ($("home") as HTMLSelectElement).value = savedHome;
  } catch {
    /* ignore */
  }
  $("home").addEventListener("change", () => {
    try {
      localStorage.setItem("ecf_home", ($("home") as HTMLSelectElement).value);
    } catch {
      /* ignore */
    }
  });
  for (const id of ["q", "audience", "grade", "subject", "category", "environment", "organizer", "country", "home", "sort", "verified"]) {
    $(id).addEventListener(id === "q" ? "input" : "change", () => {
      $("appliedChips").innerHTML = "";
      render();
    });
  }
  $("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = ($("askInput") as HTMLInputElement).value.trim();
    if (t) void ask(t);
  });
  $("cardsGrid").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const id = btn.closest<HTMLElement>(".card")!.dataset.id!;
    const a = getById(ALL, id)!;
    const act = btn.dataset.act;
    if (act === "save") {
      saved.has(id) ? saved.delete(id) : saved.add(id);
      persist();
      render();
    } else if (act === "cmp") {
      if (compareSet.has(id)) compareSet.delete(id);
      else if (compareSet.size < 3) compareSet.add(id);
      else toast("You can compare up to 3 programs.");
      render();
    } else if (act === "why") {
      openWhy.has(id) ? openWhy.delete(id) : openWhy.add(id);
      const box = $(`why-${id}`);
      box.innerHTML = openWhy.has(id) ? whyHtml(a) : "";
      box.classList.toggle("open", openWhy.has(id));
    } else if (act === "report") showReport(a);
  });
  $("compareBtn").addEventListener("click", showCompare);
  $("clearCmpBtn").addEventListener("click", () => {
    compareSet.clear();
    render();
  });
  $("savedBtn").addEventListener("click", showSaved);
  $("suggestBtn").addEventListener("click", () => showReport(undefined, true));
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal();
  });
  render();
}

void init();
