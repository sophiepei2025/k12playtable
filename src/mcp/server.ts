import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACTIVITIES } from "../core/data.js";
import type { Activity } from "../core/schema.js";
import { compare, getById, search } from "../core/search.js";
import { explainSignals } from "../core/signals.js";
import { buildIssueReport } from "../core/issue.js";
import { planningRules } from "../core/planning-rules.js";
import { checkConflicts, getDeadlines, toICS } from "../core/planner.js";

/**
 * Same skeleton as edmoat-seo-geo-mcp / marketing-mcp (Meridian pattern):
 * factory + okJson/errJson. Free tools are read-only and need no key.
 * Paid tools register only when the request is authorised (ctx.paid).
 */

export interface RuntimeContext {
  /** True when the caller presented a valid paid-access token (stopgap until OAuth 2.1). */
  paid?: boolean;
  /** Dataset override for tests. */
  activities?: Activity[];
  env?: Record<string, string | undefined>;
  today?: string;
}

const VERSION = "0.1.0";

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errJson(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }] };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const planItem = z.object({
  id: z.string().describe("Activity id from search_activities, or a label for a fixed commitment such as 'swim-team'"),
  name: z.string().optional(),
  start: z.string().nullable().describe("YYYY-MM-DD or null if unknown"),
  end: z.string().nullable().describe("YYYY-MM-DD or null if unknown"),
  hours_per_week: z.number().nullable(),
  in_person: z.boolean().optional(),
  residential: z.boolean().optional(),
  role: z.enum(["primary", "backup", "fixed"]).optional(),
  app_deadline: z.string().nullable().optional(),
  app_open: z.string().nullable().optional(),
  decision: z.string().nullable().optional(),
  deposit: z.string().nullable().optional(),
  needs_rec_letter: z.boolean().optional(),
  needs_essay: z.boolean().optional(),
  online: z.boolean().optional().describe("Online items cost no travel"),
  commute_minutes_one_way: z.number().nullable().optional().describe("Door-to-door minutes one way; use search_activities est_commute_minutes or ask the family"),
  sessions_per_week: z.number().nullable().optional().describe("Trips per week"),
  session_hours: z.number().nullable().optional(),
});

export function createExtracurricularMcpServer(ctx: RuntimeContext = {}): McpServer {
  const list = ctx.activities ?? ACTIVITIES;
  const env = ctx.env ?? process.env;

  const server = new McpServer({ name: "edmoat-extracurriculars", version: VERSION });

  // ===========================================================================
  // FREE TOOLS (anonymous, read-only)
  // ===========================================================================

  server.registerTool(
    "search_activities",
    {
      title: "Search extracurricular activities",
      description:
        "Search North American extracurricular programs, competitions and research opportunities for high school students. Use when a parent or counselor asks what activities fit a grade, subject, budget, format, location or deadline. Returns summaries with the five decision fields (cost, application deadline, hours per week, selectivity, international eligibility) plus a logistics band (online / close / moderate / long commute / travel / unknown); null means not yet verified, never 'free' or 'open'. Ask for the family's home city and whether a parent drives, then pass home_city and choose sort=signal or sort=convenience.",
      inputSchema: {
        q: z.string().optional().describe("Keywords, e.g. 'robotics', 'math olympiad', 'Google'"),
        audience: z.array(z.enum(["high_school", "undergraduate", "graduate"])).optional().describe("Default: all audiences. Use ['high_school'] for high school families."),
        grade: z.number().int().min(9).max(12).optional(),
        subjects: z.array(z.string()).optional().describe("Any-match, e.g. ['Computer Science','Biology']"),
        category: z.array(z.enum(["Program", "Competition", "Academic Research", "Community Service", "Club"])).optional(),
        environment: z.array(z.enum(["in_person", "hybrid", "online"])).optional(),
        commitment: z.enum(["short_term", "long_term"]).optional(),
        organizer_type: z.array(z.enum(["company", "nonprofit", "university_program", "education_org", "government"])).optional(),
        big_company: z.boolean().optional().describe("true = programs run by large companies"),
        country: z.array(z.enum(["US", "CA", "Global"])).optional(),
        fee: z.enum(["free", "paid"]).optional().describe("Only verified fee data matches"),
        max_cost: z.number().optional().describe("Only activities with a verified cost at or below this amount"),
        deadline_month: z.number().int().min(1).max(12).optional(),
        international_ok: z.boolean().optional(),
        selective_only: z.boolean().optional(),
        verified_only: z.boolean().optional(),
        include_discontinued: z.boolean().optional(),
        home_city: z.string().optional().describe("Family's city, e.g. 'Markham', 'Toronto', 'Waterloo'. Enables commute estimates (straight-line based, approximate)."),
        max_commute_minutes: z.number().optional().describe("Hide programs whose estimated one-way commute is above this; unknown locations are kept"),
        sort: z
          .enum(["relevance", "signal", "convenience", "deadline", "name"])
          .optional()
          .describe("signal (default): free+selective first, logistics breaks ties. convenience: online / close to home first, then signal."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        return okJson({ ...search(list, args), dataset_size: list.length, note: "null = not verified yet; confirm on the official link." });
      } catch (e) {
        return errJson(e);
      }
    },
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get one activity",
      description: "Get every field of one activity, including dates, cost, eligibility, sources and last_verified. Use after search_activities when the family is considering a specific program.",
      inputSchema: { id: z.string().describe("Activity id from search_activities") },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const a = getById(list, id);
      return a ? okJson(a) : errJson(`No activity with id "${id}". Use search_activities to find ids.`);
    },
  );

  server.registerTool(
    "compare_activities",
    {
      title: "Compare activities side by side",
      description: "Compare 2–3 activities on cost, deadline, dates, hours, format, selectivity, eligibility and outputs. Use when a family is choosing between options.",
      inputSchema: { ids: z.array(z.string()).min(2).max(3) },
      annotations: READ_ONLY,
    },
    async ({ ids }) => okJson(compare(list, ids)),
  );

  server.registerTool(
    "explain_signals",
    {
      title: "Explain what an activity signals",
      description:
        "Explain an activity's admissions-relevant signals in plain language: who runs it (company / nonprofit / university / education company / government) and what that usually means, cost and aid, selectivity, outputs, red flags and caveats. Use when a parent asks 'is this worth it?' or 'is this a real program?'. It never gives a subjective score.",
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const a = getById(list, id);
      return a ? okJson(explainSignals(a, ctx.today ? new Date(ctx.today) : new Date())) : errJson(`No activity with id "${id}".`);
    },
  );

  server.registerTool(
    "report_issue",
    {
      title: "Report wrong or outdated data",
      description: "Report an error in an activity's data (wrong deadline, fee, eligibility, dead link, discontinued program). Returns a pre-filled report link for the person to submit; nothing is stored.",
      inputSchema: {
        activity_id: z.string(),
        field: z.string().optional().describe("e.g. 'dates.app_deadline', 'cost', 'link'"),
        problem: z.string().min(3).max(1000),
        correct_value: z.string().optional(),
        evidence_url: z.string().url().optional().describe("Official page that shows the correct value"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => okJson(buildIssueReport(args, getById(list, args.activity_id), env)),
  );

  server.registerTool(
    "get_planning_rules",
    {
      title: "Get the scheduling rules (skill)",
      description: "Return the scheduling skill: hard constraints, adjustable defaults (weekly hour caps, exam buffers, lead times), grade-by-grade rhythm, step-by-step method and output format. Read this before building a multi-term activity plan for a student.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => okJson(planningRules()),
  );

  // ===========================================================================
  // PAID TOOLS (only when authorised)
  // ===========================================================================
  if (ctx.paid) {
    server.registerTool(
      "check_conflicts",
      {
        title: "Check a plan for conflicts",
        description: "Deterministically check a draft plan: date overlaps, residential travel buffers, weekly hour caps (term vs summer, student commute included), one-way commute limit, parent driving/pick-up hours per week, exam-period starts, passed deadlines and missing data. Always use this instead of doing date or hour arithmetic yourself.",
        inputSchema: {
          items: z.array(planItem).min(1),
          exams: z.array(z.object({ start: z.string(), end: z.string(), label: z.string().optional() })).optional(),
          config: z
            .object({ school_term_max_hours: z.number().optional(), summer_max_hours: z.number().optional(), exam_buffer_days: z.number().optional() })
            .optional()
            .describe("Family-specific overrides of the defaults"),
          family: z
            .object({
              transport: z.enum(["parent_drive", "transit", "self"]).optional().describe("Who gets the student there; parent hours only count for parent_drive"),
              max_commute_minutes: z.number().optional(),
              parent_max_hours_per_week: z.number().optional(),
            })
            .optional(),
        },
        annotations: READ_ONLY,
      },
      async ({ items, exams, config, family }) => {
        try {
          return okJson(checkConflicts(items, { exams, config, family, today: ctx.today }));
        } catch (e) {
          return errJson(e);
        }
      },
    );

    server.registerTool(
      "get_deadlines",
      {
        title: "Build a deadline and reminder timeline",
        description: "Turn plan items into a dated timeline: application opens, prep start (essay / recommendation lead time), reminders 30/7/1 days before, deadline, decision, deposit. Optionally returns an .ics calendar the family can import.",
        inputSchema: { items: z.array(planItem).min(1), include_ics: z.boolean().optional() },
        annotations: READ_ONLY,
      },
      async ({ items, include_ics }) => {
        const events = getDeadlines(items, { today: ctx.today });
        return okJson(include_ics ? { events, ics: toICS(events) } : { events });
      },
    );
  }

  // ===========================================================================
  // PROMPTS
  // ===========================================================================
  server.registerPrompt(
    "plan-my-year",
    {
      title: "Plan my child's activities",
      description: "Build a term-by-term extracurricular plan for one student.",
      argsSchema: {
        grade: z.string().describe("Current grade, e.g. '10'"),
        interests: z.string().describe("Subjects or goals, e.g. 'computer science, maybe medicine'"),
        city: z.string().optional(),
        budget: z.string().optional().describe("Yearly budget incl. travel, e.g. 'CAD 3000'"),
        transport: z.string().optional().describe("Who drives: 'parent drives', 'transit', 'student goes alone'"),
      },
    },
    ({ grade, interests, city, budget, transport }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call get_planning_rules first and follow it. Then use search_activities (audience high_school, grade ${grade}) and get_activity to build a plan for a grade ${grade} student interested in ${interests}${city ? `, living in ${city}` : ""}${budget ? `, budget ${budget}` : ""}${transport ? `, transport: ${transport}` : ""}. Pass home_city to search_activities and weigh online vs in person, commute and parent driving time (rules S5, S7, S8). Use check_conflicts and get_deadlines if they are available; otherwise check the rules by hand and say which checks you could not run. Mark every unverified fact as unverified.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "compare-programs",
    {
      title: "Compare programs for a family",
      description: "Help a family decide between two or three programs.",
      argsSchema: { names: z.string().describe("Program names or ids, comma separated") },
    },
    ({ names }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find these programs with search_activities: ${names}. Then call compare_activities and explain_signals for each. Lead with a recommendation tied to cost, selectivity and the student's goals, and list what is still unverified.`,
          },
        },
      ],
    }),
  );

  return server;
}
