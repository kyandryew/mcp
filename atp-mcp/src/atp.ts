/**
 * Thin client for the AnswerThePublic Public API.
 * Docs surface: https://api.answerthepublic.com  (OpenAPI 3.0.1)
 *
 * Auth: a single Personal Access Token (atp_pk_live_*) sent as a Bearer token.
 * The token is bound to one user + one workspace, so no workspace id is ever passed.
 */

const BASE_URL = process.env.ATP_BASE_URL?.replace(/\/+$/, "") ?? "https://api.answerthepublic.com";
const TOKEN = process.env.ATP_TOKEN;

if (!TOKEN) {
  // Fail loud at boot so a misconfigured deploy is obvious instead of returning 401s forever.
  console.error("[atp-mcp] FATAL: ATP_TOKEN env var is not set. Set it to your atp_pk_live_* token.");
}

export class AtpError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AtpError";
    this.status = status;
    this.details = details;
  }
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request<T = unknown>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {}
): Promise<T> {
  if (!TOKEN) {
    throw new AtpError("Server is missing ATP_TOKEN. Configure the connector's ATP_TOKEN env var.", 500);
  }

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (rare) — fall through with raw text in the error.
  }

  if (!res.ok) {
    const message: string =
      json?.error?.message ?? `AnswerThePublic API returned ${res.status}`;
    const details = json?.error?.details;
    // Bubble a clean, human-readable error up to the MCP tool layer.
    throw new AtpError(message, res.status, details);
  }

  return json as T;
}

/* ---------------------------------------------------------------- *
 *  Endpoint wrappers — one per public route in the OpenAPI spec.    *
 * ---------------------------------------------------------------- */

export function me() {
  return request("GET", "/api/public/v1/me");
}

export interface CreateSearchInput {
  keyword: string;
  language: string;
  region: string;
  provider?: string;
}

export function createSearch(input: CreateSearchInput) {
  const { keyword, language, region, provider } = input;
  return request("POST", "/api/public/v1/searches", {
    body: { search: { keyword, language, region, ...(provider ? { provider } : {}) } },
  });
}

export function getSearch(id: string) {
  return request("GET", `/api/public/v1/searches/${encodeURIComponent(id)}`);
}

export interface ListSearchesInput {
  page?: number;
  per_page?: number;
  sort_by?: "asc" | "desc";
  region?: string;
  language?: string;
  provider?: string;
  q?: string;
}

export function listSearches(input: ListSearchesInput = {}) {
  return request("GET", "/api/public/v1/searches", { query: input as Record<string, unknown> });
}

export interface GetReportInput {
  id: string;
  providers?: string;
  grouped?: boolean;
  source_name?: string;
  category?: string;
  page?: number;
  per_page?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  range_start_volume?: number;
  range_end_volume?: number;
  range_start_cost?: number;
  range_end_cost?: number;
  search_string?: string;
  intents?: string;
  sentiments?: string;
}

export function getReport(input: GetReportInput) {
  const { id, ...query } = input;
  return request("GET", `/api/public/v1/reports/${encodeURIComponent(id)}`, { query: query as Record<string, unknown> });
}

export interface AiPromptsInput {
  id: string;
  page?: number;
  intents?: string;
}

export function aiPrompts(input: AiPromptsInput) {
  const { id, ...query } = input;
  return request("POST", `/api/public/v1/reports/${encodeURIComponent(id)}/ai/prompts`, { query: query as Record<string, unknown> });
}

export function aiAnswerRequest(id: string, ai_prompt_id: string) {
  return request("POST", `/api/public/v1/reports/${encodeURIComponent(id)}/ai/answer_request`, {
    body: { ai_prompt_id },
  });
}

export function aiAnswer(id: string, task_id: string) {
  return request("POST", `/api/public/v1/reports/${encodeURIComponent(id)}/ai/answer`, {
    body: { task_id },
  });
}
