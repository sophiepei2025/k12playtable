import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { LlmClient, LlmError, safeJson, type LlmUsage } from "../src/core/llm.js";
import { parseQuery } from "../src/core/nlquery.js";
import { ACTIVITIES } from "../src/core/data.js";
import { verifyQuotes, toPatch, htmlToText, Extracted } from "../scripts/extract-fields.js";

function mockFetch(replies: string[], seen: Array<{ url: string; body: Record<string, unknown> }> = []) {
  return async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    const content = replies.shift() ?? "{}";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 });
  };
}

test("qwen-us is the default provider, US endpoint, task routing, thinking off", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const usage: LlmUsage[] = [];
  const c = new LlmClient({ env: { DASHSCOPE_API_KEY: "k" }, fetchImpl: mockFetch(['{"a":1}'], seen), onUsage: (u) => usage.push(u) });
  assert.equal(c.provider, "qwen-us");
  assert.ok(c.familyDataOk);
  await c.chatJson("nl_search", "s", "u", z.object({ a: z.number() }));
  assert.equal(seen[0].url, "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(seen[0].body.model, "qwen3.7-flash");
  assert.equal(seen[0].body.enable_thinking, false);
  assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  assert.ok(Math.abs((usage[0].cost_usd ?? 0) - (1000 * 0.03 + 100 * 0.13) / 1e6) < 1e-12);
  assert.equal(c.modelFor("plan"), "qwen3.7-plus");
});

test("env overrides model per task; mainland providers refuse family data", async () => {
  const c = new LlmClient({ env: { DASHSCOPE_API_KEY: "k", LLM_MODEL_NL_SEARCH: "qwen3.8-flash" } });
  assert.equal(c.modelFor("nl_search"), "qwen3.8-flash");
  const ds = new LlmClient({ env: { LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k" }, fetchImpl: mockFetch(["{}"]) });
  await assert.rejects(ds.chat("plan", [{ role: "user", content: "x" }], { containsFamilyData: true }), LlmError);
  assert.throws(() => new LlmClient({ env: { LLM_PROVIDER: "nope" } }), LlmError);
});

test("chatJson repairs once, then fails loudly", async () => {
  const ok = new LlmClient({ env: { DASHSCOPE_API_KEY: "k" }, fetchImpl: mockFetch(["not json", '```json\n{"a":2}\n```']) });
  assert.deepEqual(await ok.chatJson("extract", "s", "u", z.object({ a: z.number() })), { a: 2 });
  const bad = new LlmClient({ env: { DASHSCOPE_API_KEY: "k" }, fetchImpl: mockFetch(["x", "y"]) });
  await assert.rejects(bad.chatJson("extract", "s", "u", z.object({ a: z.number() })), /invalid JSON/);
  assert.deepEqual(safeJson('text {"b":1} tail'), { b: 1 });
});

test("parseQuery: LLM filters are validated; fallback without key", async () => {
  const c = new LlmClient({
    env: { DASHSCOPE_API_KEY: "k" },
    fetchImpl: mockFetch(['{"grade":10,"country":["CA"],"fee":"free","subjects":["Computer Science"],"q":null,"category":[]}']),
  });
  const r = await parseQuery("free CS programs for my grade 10 kid in Canada", ACTIVITIES, c, "2026-11-23");
  assert.equal(r.source, "llm");
  assert.deepEqual(r.filters, { grade: 10, country: ["CA"], fee: "free", subjects: ["Computer Science"], audience: ["high_school"] });
  const none = await parseQuery("robotics", ACTIVITIES, new LlmClient({ env: {} }));
  assert.deepEqual(none, { filters: { audience: ["high_school"], q: "robotics" }, source: "fallback", note: "LLM not configured; used keyword rules." });
  const badModel = new LlmClient({ env: { DASHSCOPE_API_KEY: "k" }, fetchImpl: mockFetch(['{"grade":99}', '{"grade":99}']) });
  assert.equal((await parseQuery("x", ACTIVITIES, badModel)).source, "fallback");
});

test("extraction guard: values without a verbatim quote are dropped", () => {
  const page = htmlToText(`<html><script>var x=1</script><p>Final deadline is January&nbsp;6, 2027.</p><p>Open to students in Grade 10 or 11.</p><p>Tuition is free.</p></html>`);
  assert.ok(!page.includes("var x"));
  const ex = Extracted.parse({
    app_deadline: { value: "2027-01-06", quote: "Final deadline is January 6, 2027" },
    grades: { value: [10, 11], quote: "Grade 10   or 11" },
    fee_type: { value: "free", quote: "Tuition is free" },
    selectivity: { value: "highly_selective", quote: "acceptance rate of 5%" }, // invented
    cost: { value: { min: 100, max: 100, currency: "USD" }, quote: null },
  });
  const { kept, dropped } = verifyQuotes(ex, page);
  assert.deepEqual(dropped.sort(), ["cost", "selectivity"]);
  const { patch, fields } = toPatch(kept);
  assert.deepEqual(patch, { fee_type: "free", dates: { app_deadline: "2027-01-06" }, eligibility: { grades: [10, 11] }, grades: [10, 11] });
  assert.deepEqual(fields.sort(), ["dates.app_deadline", "eligibility.grades", "fee_type"]);
});

test("keywordFilters: rules for grade, country, format, type; stopwords removed", async () => {
  const { keywordFilters } = await import("../src/core/nlquery.js");
  assert.deepEqual(keywordFilters("robotics competitions for my grade 10 kid in Canada"), {
    audience: ["high_school"], grade: 10, country: ["CA"], category: ["Competition"], q: "robotics",
  });
  assert.deepEqual(keywordFilters("online CS research for 11th grade"), { audience: ["high_school"], grade: 11, environment: ["online"], category: ["Academic Research"], q: "cs" });
  assert.equal(keywordFilters("十年级 多伦多 机器人").grade, 10);
});
