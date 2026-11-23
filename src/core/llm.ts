/**
 * One OpenAI-compatible client for every provider (Qwen default).
 * Ported from volcengine-ark-kit's ArkClient.chat_completion, generalised.
 *
 * Routing: each task gets its own model (see TASK_MODELS); override with
 *   LLM_PROVIDER=qwen-cn|qwen-us|qwen-intl|ark|deepseek   (MVP default: qwen-cn)
 *   LLM_MODEL_<TASK>=model-id      e.g. LLM_MODEL_NL_SEARCH=qwen3.8-flash
 *
 * Data rule: calls that carry family data must use a provider whose
 * `family_data_ok` is true (Qwen US scope on dashscope-us), OR a provider the
 * owner explicitly allows via LLM_ALLOW_FAMILY_DATA_ON (MVP: qwen-cn).
 * Switching to the US later = set LLM_PROVIDER=qwen-us + DASHSCOPE_API_KEY_US
 * and remove LLM_ALLOW_FAMILY_DATA_ON. No code change.
 */
import type { ZodType } from "zod";

export type ProviderId = "qwen-cn" | "qwen-us" | "qwen-intl" | "ark" | "deepseek";
export type Task = "nl_search" | "extract" | "plan" | "prefill" | "email";

interface Provider {
  baseUrl: string;
  keyEnv: string;
  /** Older single-key name, still accepted. */
  keyFallbackEnv?: string;
  family_data_ok: boolean;
  note: string;
  /** Extra body fields this provider expects. */
  extra?: Record<string, unknown>;
}

export const DEFAULT_PROVIDER: ProviderId = "qwen-cn";

export const PROVIDERS: Record<ProviderId, Provider> = {
  "qwen-cn": {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY_CN",
    keyFallbackEnv: "DASHSCOPE_API_KEY",
    family_data_ok: false,
    note: "Alibaba Model Studio, China (Beijing). MVP default. Family data only if LLM_ALLOW_FAMILY_DATA_ON includes qwen-cn.",
    extra: { enable_thinking: false },
  },
  "qwen-us": {
    baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY_US",
    keyFallbackEnv: "DASHSCOPE_API_KEY",
    family_data_ok: true,
    note: "Alibaba Model Studio, US (Virginia), US deployment scope. Use a key from the Virginia key page.",
    extra: { enable_thinking: false },
  },
  "qwen-intl": {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY_INTL",
    keyFallbackEnv: "DASHSCOPE_API_KEY",
    family_data_ok: false,
    note: "Alibaba Model Studio, Singapore. Public data only until data-residency is confirmed.",
    extra: { enable_thinking: false },
  },
  ark: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyEnv: "ARK_API_KEY",
    family_data_ok: false,
    note: "Volcengine Ark, Beijing. Public data only.",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
    family_data_ok: false,
    note: "DeepSeek official API, mainland China. Public data only.",
  },
};

/** Default model per task and provider (prices: Model Studio pricing page, 2026-11-23). */
export const TASK_MODELS: Record<ProviderId, Record<Task, string>> = {
  "qwen-cn": { nl_search: "qwen3.7-flash", extract: "qwen-flash", plan: "qwen3.7-plus", prefill: "qwen-flash", email: "qwen3.7-flash" },
  "qwen-us": { nl_search: "qwen3.7-flash", extract: "qwen-flash", plan: "qwen3.7-plus", prefill: "qwen-flash", email: "qwen3.7-flash" },
  "qwen-intl": { nl_search: "qwen3.7-flash", extract: "qwen-flash", plan: "qwen3.7-plus", prefill: "qwen-flash", email: "qwen3.7-flash" },
  ark: { nl_search: "doubao-seed-2-0-mini-260428", extract: "doubao-seed-2-0-lite-260428", plan: "doubao-seed-2-1-turbo", prefill: "doubao-seed-2-0-lite-260428", email: "doubao-seed-2-0-mini-260428" },
  deepseek: { nl_search: "deepseek-flash", extract: "deepseek-flash", plan: "deepseek-flash", prefill: "deepseek-flash", email: "deepseek-flash" },
};

const CNY = 7.1; // assumed CNY per USD, for cost logging only

/**
 * USD per 1M tokens [input, output], lowest input tier, for cost logging only.
 * Sources: Model Studio pricing pages, checked 2026-11-23. Unknown → cost = null.
 */
export const PRICES_USD: Partial<Record<ProviderId, Record<string, [number, number]>>> = {
  "qwen-cn": {
    "qwen3.7-flash": [0.2 / CNY, 0.8 / CNY],
    "qwen-flash": [0.15 / CNY, 1.5 / CNY],
    "qwen3.7-plus": [2 / CNY, 8 / CNY],
    "qwen-plus": [0.8 / CNY, 2 / CNY],
  },
  "qwen-us": {
    "qwen3.7-flash": [0.03, 0.13],
    "qwen-flash": [0.05, 0.4],
    "qwen3.8-flash": [0.15, 0.47],
    "qwen3.7-plus": [0.4, 1.6],
  },
  deepseek: { "deepseek-flash": [2 / CNY, 8 / CNY] }, // peak price
};

export function priceFor(provider: ProviderId, model: string): [number, number] | undefined {
  return PRICES_USD[provider]?.[model];
}

export interface LlmUsage {
  provider: ProviderId;
  model: string;
  task: Task;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  ms: number;
}

export class LlmError extends Error {}

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmOptions {
  env?: Env;
  fetchImpl?: FetchLike;
  onUsage?: (u: LlmUsage) => void;
  timeoutMs?: number;
}

export class LlmClient {
  readonly provider: ProviderId;
  private readonly env: Env;
  private readonly fetchImpl: FetchLike;
  private readonly onUsage?: (u: LlmUsage) => void;
  private readonly timeoutMs: number;

  constructor(opts: LlmOptions = {}) {
    this.env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
    const p = ((this.env.LLM_PROVIDER ?? "").trim() || DEFAULT_PROVIDER) as ProviderId;
    if (!PROVIDERS[p]) throw new LlmError(`Unknown LLM_PROVIDER "${p}". Use one of ${Object.keys(PROVIDERS).join(", ")}.`);
    this.provider = p;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.onUsage = opts.onUsage;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get configured(): boolean {
    return Boolean(this.apiKey());
  }

  get familyDataOk(): boolean {
    const allowed = (this.env.LLM_ALLOW_FAMILY_DATA_ON ?? "").split(",").map((s) => s.trim());
    return PROVIDERS[this.provider].family_data_ok || allowed.includes(this.provider);
  }

  private apiKey(): string | undefined {
    const p = PROVIDERS[this.provider];
    return this.env[p.keyEnv]?.trim() || (p.keyFallbackEnv ? this.env[p.keyFallbackEnv]?.trim() : undefined) || undefined;
  }

  private baseUrl(): string {
    return (this.env.LLM_BASE_URL ?? PROVIDERS[this.provider].baseUrl).replace(/\/+$/, "");
  }

  modelFor(task: Task): string {
    return this.env[`LLM_MODEL_${task.toUpperCase()}`] ?? TASK_MODELS[this.provider][task];
  }

  /** Raw chat call. Returns the assistant text. */
  async chat(task: Task, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, opts: { json?: boolean; maxTokens?: number; containsFamilyData?: boolean } = {}): Promise<string> {
    const key = this.apiKey();
    if (!key) throw new LlmError(`${PROVIDERS[this.provider].keyEnv} is not set.`);
    if (opts.containsFamilyData && !this.familyDataOk)
      throw new LlmError(`Provider ${this.provider} is not approved for family data. Use LLM_PROVIDER=qwen-us, or allow it explicitly with LLM_ALLOW_FAMILY_DATA_ON=${this.provider}.`);
    const model = this.modelFor(task);
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      ...(PROVIDERS[this.provider].extra ?? {}),
    };
    const t0 = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new LlmError(`LLM ${this.provider}/${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const pt = data.usage?.prompt_tokens ?? 0;
    const ct = data.usage?.completion_tokens ?? 0;
    const price = priceFor(this.provider, model);
    this.onUsage?.({
      provider: this.provider,
      model,
      task,
      prompt_tokens: pt,
      completion_tokens: ct,
      cost_usd: price ? (pt * price[0] + ct * price[1]) / 1e6 : null,
      ms: Date.now() - t0,
    });
    return text;
  }

  /** Chat that must return JSON matching `schema`. One repair retry on invalid output. */
  async chatJson<T>(task: Task, system: string, user: string, schema: ZodType<T>, opts: { maxTokens?: number; containsFamilyData?: boolean } = {}): Promise<T> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.chat(task, messages, { json: true, ...opts });
      const parsed = safeJson(text);
      const result = parsed === undefined ? null : schema.safeParse(parsed);
      if (result?.success) return result.data;
      lastErr = result ? result.error.message.slice(0, 500) : "not valid JSON";
      messages.push({ role: "assistant", content: text }, { role: "user", content: `Your output was invalid (${lastErr}). Return only corrected JSON.` });
    }
    throw new LlmError(`LLM returned invalid JSON for ${task}: ${lastErr}`);
  }
}

export function safeJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}
