import type { Activity } from "./schema.js";

/**
 * Stateless issue reporting: the MCP server and API keep no database in the MVP,
 * so a report becomes a pre-filled GitHub issue link (ISSUES_REPO) or a mailto
 * (FEEDBACK_EMAIL). The person (or their agent) opens it to submit.
 */
export interface IssueInput {
  activity_id: string;
  field?: string;
  problem: string;
  correct_value?: string;
  evidence_url?: string;
}

export function buildIssueReport(input: IssueInput, activity: Activity | undefined, env: Record<string, string | undefined> = process.env) {
  const title = `[data] ${activity?.name ?? input.activity_id}${input.field ? ` · ${input.field}` : ""}`;
  const body = [
    `**Activity id:** ${input.activity_id}`,
    activity ? `**Official link:** ${activity.link}` : "**Note:** id not found in the dataset",
    input.field ? `**Field:** ${input.field}` : null,
    `**Problem:** ${input.problem}`,
    input.correct_value ? `**Correct value:** ${input.correct_value}` : null,
    input.evidence_url ? `**Evidence:** ${input.evidence_url}` : null,
    activity?.last_verified ? `**Last verified:** ${activity.last_verified}` : "**Last verified:** never",
  ]
    .filter(Boolean)
    .join("\n");
  const repo = env.ISSUES_REPO?.trim();
  const email = env.FEEDBACK_EMAIL?.trim();
  return {
    title,
    body,
    submit_url: repo
      ? `https://github.com/${repo}/issues/new?labels=data&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
      : null,
    mailto: email ? `mailto:${email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` : null,
    note: repo || email ? "Open submit_url (or mailto) to send the report." : "No reporting channel configured; copy title and body to the site owner.",
  };
}
