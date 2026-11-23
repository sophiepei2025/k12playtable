import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createExtracurricularMcpServer } from "../src/mcp/server.js";
import { handleHttpRequest } from "../src/mcp/http.js";

async function connect(paid: boolean) {
  const server = createExtracurricularMcpServer({ paid, today: "2026-11-23", env: { ISSUES_REPO: "owner/repo" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const parse = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0].text);

test("free tier: 6 read-only tools + 2 prompts; paid tools hidden", async () => {
  const c = await connect(false);
  const tools = (await c.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["compare_activities", "explain_signals", "get_activity", "get_planning_rules", "report_issue", "search_activities"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.deepEqual((await c.listPrompts()).prompts.map((p) => p.name).sort(), ["compare-programs", "plan-my-year"]);
});

test("tools return useful JSON", async () => {
  const c = await connect(false);
  const s = parse(await c.callTool({ name: "search_activities", arguments: { country: ["CA"], audience: ["high_school"] } }));
  assert.ok(s.results.some((r: { id: string }) => r.id === "shad-canada"));
  const g = parse(await c.callTool({ name: "get_activity", arguments: { id: "shad-canada" } }));
  assert.equal(g.dates.app_deadline, "2027-01-06");
  const missing = await c.callTool({ name: "get_activity", arguments: { id: "nope" } });
  assert.equal(missing.isError, true);
  const sig = parse(await c.callTool({ name: "explain_signals", arguments: { id: "shad-canada" } }));
  assert.equal(sig.organizer_type, "nonprofit");
  const rep = parse(await c.callTool({ name: "report_issue", arguments: { activity_id: "shad-canada", field: "cost", problem: "Fee missing" } }));
  assert.match(rep.submit_url, /^https:\/\/github\.com\/owner\/repo\/issues\/new\?/);
  const rules = parse(await c.callTool({ name: "get_planning_rules", arguments: {} }));
  assert.equal(rules.defaults.school_term_max_hours, 10);
});

test("paid tier: check_conflicts and get_deadlines", async () => {
  const c = await connect(true);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("check_conflicts") && names.includes("get_deadlines"));
  const r = parse(
    await c.callTool({
      name: "check_conflicts",
      arguments: {
        items: [
          { id: "shad-canada", start: "2027-07-04", end: "2027-07-30", hours_per_week: 40, residential: true },
          { id: "camp", start: "2027-07-12", end: "2027-07-23", hours_per_week: 20, in_person: true },
        ],
      },
    }),
  );
  assert.ok(r.conflicts.some((x: { type: string }) => x.type === "overlap"));
  const lg = parse(
    await c.callTool({
      name: "check_conflicts",
      arguments: {
        items: [{ id: "club", start: "2027-01-11", end: "2027-02-28", hours_per_week: 3, sessions_per_week: 2, session_hours: 1.5, commute_minutes_one_way: 40 }],
        family: { transport: "parent_drive", parent_max_hours_per_week: 4 },
      },
    }),
  );
  assert.ok(lg.conflicts.some((x: { type: string }) => x.type === "parent_time"));
  assert.equal(lg.weekly_load[0].parent_hours, 5.3);
  const near = parse(await c.callTool({ name: "search_activities", arguments: { home_city: "Waterloo", sort: "convenience", country: ["CA"] } }));
  assert.ok(near.results.every((x: { logistics: string }) => typeof x.logistics === "string"));
  const d = parse(await c.callTool({ name: "get_deadlines", arguments: { items: [{ id: "shad-canada", start: null, end: null, hours_per_week: null, app_deadline: "2027-01-06" }], include_ics: true } }));
  assert.match(d.ics, /BEGIN:VCALENDAR/);
});

test("HTTP: stateless Streamable HTTP, health, paid token", async () => {
  process.env.PAID_ACCESS_TOKENS = "secret-1, secret-2";
  const server: Server = createServer((req, res) => void handleHttpRequest(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.ok(health.activities >= 333);

    const free = new Client({ name: "t", version: "0" });
    await free.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.ok(!(await free.listTools()).tools.some((t) => t.name === "check_conflicts"));
    await free.close();

    const paid = new Client({ name: "t", version: "0" });
    await paid.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer secret-2" } } }));
    assert.ok((await paid.listTools()).tools.some((t) => t.name === "check_conflicts"));
    await paid.close();
  } finally {
    delete process.env.PAID_ACCESS_TOKENS;
    server.close();
  }
});
