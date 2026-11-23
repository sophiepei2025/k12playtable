import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEmail, readUtm, waitlistBody, waitlistMailto } from "../src/web/waitlist.js";

test("readUtm keeps only utm_* params, trimmed and capped", () => {
  const u = readUtm("?utm_source=xhs&utm_medium= social &utm_campaign=" + "x".repeat(150) + "&foo=bar");
  assert.equal(u.utm_source, "xhs");
  assert.equal(u.utm_medium, "social");
  assert.equal(u.utm_campaign?.length, 100);
  assert.equal((u as Record<string, string>).foo, undefined);
  assert.deepEqual(readUtm(""), {});
});

test("isValidEmail", () => {
  assert.ok(isValidEmail("parent@example.com"));
  assert.ok(!isValidEmail("parent@example"));
  assert.ok(!isValidEmail("not an email"));
});

test("waitlist body carries role, grade and source for channel attribution", () => {
  const body = waitlistBody({ email: "a@b.co", role: "parent", grade: "10" }, { utm_source: "instagram", utm_campaign: "summer" }, "instagram.com");
  assert.match(body, /Role: parent/);
  assert.match(body, /Child's grade: 10/);
  assert.match(body, /Source: instagram/);
  assert.match(body, /Campaign: summer/);
  assert.match(body, /Referrer: instagram.com/);
  assert.match(waitlistBody({ email: "a@b.co", role: "counselor" }, {}), /Source: direct/);
});

test("waitlist mailto is null without an inbox, encoded otherwise", () => {
  const input = { email: "a@b.co", role: "parent" };
  assert.equal(waitlistMailto(input, {}, undefined), null);
  const link = waitlistMailto(input, { utm_source: "reddit" }, "hello@example.com")!;
  assert.ok(link.startsWith("mailto:hello%40example.com?subject="));
  assert.match(decodeURIComponent(link), /Early access: parent \(reddit\)/);
});
