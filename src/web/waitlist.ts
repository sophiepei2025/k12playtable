/**
 * Early-access / waitlist capture for market testing. No backend yet:
 * builds a mailto to FEEDBACK_EMAIL and carries UTM attribution so each
 * social channel can be measured from the inbox alone.
 */

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export interface WaitlistInput {
  email: string;
  role: string; // parent | counselor | student | other
  grade?: string;
  note?: string;
}

/** Read UTM params from a query string; values trimmed and capped at 100 chars. */
export function readUtm(search: string): Utm {
  const p = new URLSearchParams(search);
  const out: Utm = {};
  for (const k of UTM_KEYS) {
    const v = p.get(k)?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (s: string) => EMAIL_RE.test(s.trim());

/** Plain-text body used in the email (and copied to clipboard as fallback). */
export function waitlistBody(input: WaitlistInput, utm: Utm, referrer = ""): string {
  const lines = [
    `Email: ${input.email.trim()}`,
    `Role: ${input.role}`,
    input.grade ? `Child's grade: ${input.grade}` : "",
    input.note?.trim() ? `What they want help with: ${input.note.trim()}` : "",
    "",
    `Source: ${utm.utm_source ?? "direct"}`,
    utm.utm_medium ? `Medium: ${utm.utm_medium}` : "",
    utm.utm_campaign ? `Campaign: ${utm.utm_campaign}` : "",
    utm.utm_content ? `Content: ${utm.utm_content}` : "",
    utm.utm_term ? `Term: ${utm.utm_term}` : "",
    referrer ? `Referrer: ${referrer}` : "",
  ];
  return lines.filter((l, i) => l !== "" || i === 4).join("\n");
}

/** mailto link, or null when no inbox is configured. */
export function waitlistMailto(input: WaitlistInput, utm: Utm, to: string | undefined, referrer = ""): string | null {
  if (!to) return null;
  const subject = `Early access: ${input.role} (${utm.utm_source ?? "direct"})`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(waitlistBody(input, utm, referrer))}`;
}
