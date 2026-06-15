/**
 * Remote MCP server for AnswerThePublic.
 *
 * Transport: Streamable HTTP (stateless) at POST /mcp.
 * Add the deployed URL (e.g. https://your-app.up.railway.app/mcp) as a
 * Custom Connector in Claude.ai: Settings -> Connectors -> Add custom connector.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  me,
  createSearch,
  getSearch,
  listSearches,
  getReport,
  aiPrompts,
  aiAnswerRequest,
  aiAnswer,
  AtpError,
} from "./atp.js";

const PROVIDERS = [
  "gweb",
  "youtube",
  "bing",
  "amazon",
  "tiktok",
  "instagram",
  "chatgpt",
  "gemini",
] as const;

/** Render any tool result as a single JSON text block. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Turn an AtpError (or anything) into a clean isError tool result. */
function fail(err: unknown) {
  const message =
    err instanceof AtpError
      ? `AnswerThePublic error (${err.status}): ${err.message}` +
        (err.details ? `\nDetails: ${JSON.stringify(err.details)}` : "")
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Build a fresh McpServer with every ATP tool registered. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "answerthepublic", version: "1.0.0" },
    {
      instructions:
        "Tools for AnswerThePublic keyword research. Typical flow:\n" +
        "1) atp_create_search with a keyword + language + region (and optionally a single provider) — this COSTS credits.\n" +
        "2) The search runs asynchronously. Poll atp_get_search with each returned child search id until status is 'completed'.\n" +
        "3) Read the structured keywords with atp_get_report using the parent_search_id (free, unlimited).\n" +
        "Re-running the same keyword+language+region within 24h reuses the existing search and does not charge again. " +
        "Use atp_me first to confirm the workspace, plan tier and token scopes.",
    }
  );

  // --- Me / health check -------------------------------------------------
  server.tool(
    "atp_me",
    "Resolve the active token to its user, workspace, plan tier and scopes. Free. Use as a health check before any credit-consuming call.",
    {},
    async () => {
      try {
        return ok(await me());
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- Create a search (COSTS CREDITS) -----------------------------------
  server.tool(
    "atp_create_search",
    "Run a keyword research search (COSTS CREDITS). Creates a parent search that fans out across providers. " +
      "Omit 'provider' to query every provider, or pass one to keep it cheap. Returns the parent_search_id plus per-provider child ids and statuses. " +
      "Snapshots are usually still 'loading' on return — poll atp_get_search, then read atp_get_report. " +
      "Re-running the same keyword+language+region within 24h reuses the result and does not charge again.",
    {
      keyword: z.string().min(1).describe("The keyword/phrase to research, e.g. 'invisalign subang jaya'."),
      language: z
        .string()
        .default("en")
        .describe("ISO 639-1 language code, e.g. 'en', 'zh', 'ms'. Coerced to 'en' for Instagram."),
      region: z
        .string()
        .default("us")
        .describe("ISO 3166-1 alpha-2 region code, e.g. 'us', 'my', 'sg', 'gb'. Coerced to 'us' for TikTok and Instagram."),
      provider: z
        .enum(PROVIDERS)
        .optional()
        .describe("Optional single provider. Omit to fan out across all providers."),
    },
    async ({ keyword, language, region, provider }) => {
      try {
        return ok(await createSearch({ keyword, language, region, provider }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- Poll a single provider search -------------------------------------
  server.tool(
    "atp_get_search",
    "Fetch one provider-specific search and its snapshot status. Free. Poll this (status: loading -> completed) after atp_create_search before reading the report.",
    {
      id: z.string().describe("A provider-specific search id returned by atp_create_search or atp_list_searches."),
    },
    async ({ id }) => {
      try {
        return ok(await getSearch(id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- List past searches ------------------------------------------------
  server.tool(
    "atp_list_searches",
    "List past parent searches in the workspace, newest first, with their per-provider children embedded. Free. Filter by keyword substring (q), provider, language or region.",
    {
      page: z.number().int().positive().optional(),
      per_page: z.number().int().positive().max(100).optional().describe("Parents per page (default 10)."),
      sort_by: z.enum(["asc", "desc"]).optional().describe("Alphabetical by keyword. Default: most recently updated."),
      region: z.string().optional(),
      language: z.string().optional(),
      provider: z.enum(PROVIDERS).optional(),
      q: z.string().optional().describe("Substring filter on the keyword."),
    },
    async (args) => {
      try {
        return ok(await listSearches(args));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- Read the report (the payoff) --------------------------------------
  server.tool(
    "atp_get_report",
    "Read the structured keyword report for a search: questions, prepositions, comparisons, alphabeticals and related — with monthly volume, CPC, intent and sentiment where the provider supports them. Free and unlimited. " +
      "Accepts a parent_search_id or any per-provider search id. Use the filters to slice the data instead of pulling everything.",
    {
      id: z.string().describe("parent_search_id (preferred) or a per-provider search id."),
      providers: z.string().optional().describe("Comma-separated providers to include, e.g. 'gweb,youtube'."),
      grouped: z.boolean().optional().describe("true = group by category/source like the dashboard; false = flat list."),
      source_name: z
        .string()
        .optional()
        .describe("Single source bucket: 'questions' | 'prepositions' | 'comparisons' | 'alphabeticals' | 'related'."),
      category: z
        .string()
        .optional()
        .describe("Sub-category, e.g. the question word for questions: who/what/where/when/why/how/which/are/can/do/is/will."),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().positive().max(500).optional().describe("Keywords per page. Defaults to 50 here to keep responses readable."),
      sort_by: z.string().optional().describe("Field to sort by: 'volume' | 'cost_per_click' | 'keyword'."),
      sort_order: z.enum(["asc", "desc"]).optional(),
      range_start_volume: z.number().optional(),
      range_end_volume: z.number().optional(),
      range_start_cost: z.number().optional(),
      range_end_cost: z.number().optional(),
      search_string: z.string().optional().describe("Case-insensitive substring filter on the keyword text."),
      intents: z.string().optional().describe("Comma-separated intent labels, e.g. 'informational,transactional'."),
      sentiments: z.string().optional().describe("Comma-separated sentiment labels, e.g. 'positive,neutral'."),
    },
    async (args) => {
      try {
        // Keep default payloads readable; callers can raise per_page when they need more.
        const per_page = args.per_page ?? 50;
        return ok(await getReport({ ...args, per_page }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- AI prompts (first call per report COSTS CREDITS) ------------------
  server.tool(
    "atp_ai_prompts",
    "List the AI prompts attached to a ChatGPT/Gemini report. NOTE: the FIRST call for a given report generates the prompts and COSTS CREDITS; later calls are free reads. Accepts a report/parent/search id.",
    {
      id: z.string().describe("Report, parent_search or search id — resolves to the latest chatgpt/gemini snapshot."),
      page: z.number().int().positive().optional(),
      intents: z.string().optional().describe("Comma-separated intent labels filter."),
    },
    async (args) => {
      try {
        return ok(await aiPrompts(args));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- AI answer request (COSTS CREDITS) ---------------------------------
  server.tool(
    "atp_ai_answer_request",
    "Enqueue generation of an AI answer for one prompt. COSTS CREDITS. Returns a task_id to poll with atp_ai_answer against the SAME id.",
    {
      id: z.string().describe("Same report/parent/search id family used for atp_ai_prompts."),
      ai_prompt_id: z.string().describe("The prompt id (from atp_ai_prompts) the model should answer."),
    },
    async ({ id, ai_prompt_id }) => {
      try {
        return ok(await aiAnswerRequest(id, ai_prompt_id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- AI answer poll ----------------------------------------------------
  server.tool(
    "atp_ai_answer",
    "Poll for an AI answer by task_id. Free. status 'processing' = keep polling; 'completed' = ai_answer is inlined. Poll against the SAME id you used for atp_ai_answer_request.",
    {
      id: z.string().describe("Same id used in atp_ai_answer_request."),
      task_id: z.string().describe("task_id returned by atp_ai_answer_request."),
    },
    async ({ id, task_id }) => {
      try {
        return ok(await aiAnswer(id, task_id));
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

/* ----------------------------- HTTP layer ----------------------------- */

const app = express();
app.use(express.json({ limit: "4mb" }));

// Simple liveness probes for the host platform.
app.get("/", (_req, res) => {
  res.json({ name: "atp-mcp-server", status: "ok", mcp_endpoint: "/mcp" });
});
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Stateless Streamable HTTP: one server + transport per request.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[atp-mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode does not support server-initiated streams or sessions.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`[atp-mcp] listening on :${PORT}  (MCP endpoint: POST /mcp)`);
});
