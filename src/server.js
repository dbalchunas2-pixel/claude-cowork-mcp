// ---------------------------------------------------------------------------
// claude-cowork-mcp
//
// A cloud-hosted MCP (Model Context Protocol) server that turns the Claude API
// into a set of callable tools. Any MCP client — Littlebird AI, another Claude
// agent, etc. — can connect over SSE and delegate work to Claude, enabling
// real AI-to-AI ("cowork") collaboration.
//
// Transport: SSEServerTransport. One McpServer instance is created per SSE
// connection; transports are tracked in a Map keyed by sessionId so that the
// POST /messages endpoint can route incoming JSON-RPC messages to the right
// open stream.
//
// Endpoints:
//   GET  /sse        -> open an SSE stream (auth-protected)
//   POST /messages   -> deliver a client message to an open stream (auth-protected)
//   GET  /health     -> liveness probe (always open)
// ---------------------------------------------------------------------------

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// ---------------------------------------------------------------------------
// Configuration (environment variables)
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN; // if unset, auth is skipped
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  // Not fatal at import time (the /health probe should still answer), but the
  // Claude-backed tools will fail until this is set.
  console.warn(
    "[claude-cowork-mcp] WARNING: ANTHROPIC_API_KEY is not set. Claude tools will return errors."
  );
}

// Single shared Anthropic client. The SDK is stateless per-request, so one
// instance is safe to reuse across every SSE connection.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Model catalog (returned verbatim by list_available_models)
// ---------------------------------------------------------------------------

const MODEL_CATALOG = {
  "claude-opus-4-8":
    "Most capable. Use for hardest reasoning, complex writing, high-stakes decisions.",
  "claude-sonnet-4-5":
    "Balanced. Best for cowork tasks, analysis, drafting, code.",
  "claude-haiku-3-5":
    "Fastest and cheapest. Use for simple lookups, summaries, classification.",
};

const MODEL_IDS = Object.keys(MODEL_CATALOG);

// Maximum self-referential recursion depth permitted for ask_claude.
const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the concatenated plain-text out of an Anthropic Messages response.
 * (A response may contain multiple content blocks; we keep only text blocks.)
 */
function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Shape an error into the MCP tool error envelope. */
function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Shape a successful text result into the MCP tool envelope. */
function toolText(text) {
  return {
    content: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// MCP server factory — one fresh server (with all 5 tools) per SSE connection
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: "claude-cowork-mcp",
    version: "1.0.0",
  });

  // -------------------------------------------------------------------------
  // 1. ask_claude — single-turn Claude call with a recursion/loop guard
  // -------------------------------------------------------------------------
  server.tool(
    "ask_claude",
    "Ask Claude a single question and get a plain-text answer. Single-turn. " +
      "Supports an optional system prompt and a depth counter that guards " +
      "against runaway AI-to-AI recursion.",
    {
      prompt: z.string().describe("The question or instruction for Claude."),
      model: z
        .string()
        .default("claude-haiku-3-5")
        .describe("Model id. See list_available_models."),
      system_prompt: z
        .string()
        .optional()
        .describe("Optional system prompt to steer Claude."),
      max_tokens: z
        .number()
        .default(1024)
        .describe("Maximum tokens in the response."),
      depth: z
        .number()
        .default(0)
        .describe(
          "Recursion depth. Increment when one Claude calls another. " +
            "Calls are rejected at depth >= " +
            MAX_DEPTH +
            "."
        ),
    },
    async ({ prompt, model, system_prompt, max_tokens, depth }) => {
      try {
        // Loop guard runs BEFORE any API call.
        if (depth >= MAX_DEPTH) {
          return toolError(
            "DEPTH_LIMIT_REACHED: max recursion depth exceeded"
          );
        }

        const message = await anthropic.messages.create({
          model,
          max_tokens,
          ...(system_prompt ? { system: system_prompt } : {}),
          messages: [{ role: "user", content: prompt }],
        });

        return toolText(extractText(message));
      } catch (err) {
        return toolError(`ask_claude failed: ${err?.message ?? String(err)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 2. run_claude_conversation — multi-turn Claude call
  // -------------------------------------------------------------------------
  server.tool(
    "run_claude_conversation",
    "Run a multi-turn conversation through Claude. Provide the full message " +
      "history; the last message must be from the user. Returns the assistant " +
      "reply as plain text.",
    {
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          })
        )
        .describe(
          "Ordered conversation history. Must be non-empty and end with a user turn."
        ),
      model: z.string().default("claude-sonnet-4-5"),
      system_prompt: z.string().optional(),
      max_tokens: z.number().default(2048),
    },
    async ({ messages, model, system_prompt, max_tokens }) => {
      try {
        // Validation -> readable error strings.
        if (!Array.isArray(messages) || messages.length === 0) {
          return toolError(
            "VALIDATION_ERROR: 'messages' must be a non-empty array of {role, content}."
          );
        }
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user") {
          return toolError(
            "VALIDATION_ERROR: the last message must have role 'user'."
          );
        }

        const message = await anthropic.messages.create({
          model,
          max_tokens,
          ...(system_prompt ? { system: system_prompt } : {}),
          messages,
        });

        return toolText(extractText(message));
      } catch (err) {
        return toolError(
          `run_claude_conversation failed: ${err?.message ?? String(err)}`
        );
      }
    }
  );

  // -------------------------------------------------------------------------
  // 3. list_available_models — hardcoded catalog, no params
  // -------------------------------------------------------------------------
  server.tool(
    "list_available_models",
    "List the Claude models this server exposes, with guidance on when to use each.",
    {},
    async () => {
      try {
        return toolText(JSON.stringify(MODEL_CATALOG, null, 2));
      } catch (err) {
        return toolError(
          `list_available_models failed: ${err?.message ?? String(err)}`
        );
      }
    }
  );

  // -------------------------------------------------------------------------
  // 4. cowork — delegate a task to a specialist Claude persona
  // -------------------------------------------------------------------------
  server.tool(
    "cowork",
    "Delegate a task to Claude acting as a specialist collaborator. Optionally " +
      "assign a specialist_role (e.g. researcher, critic, writer, devil's " +
      "advocate, strategist) to shape the system prompt. Returns Claude's full response.",
    {
      task: z.string().describe("The task for the specialist to complete."),
      context: z
        .string()
        .optional()
        .describe("Optional background context for the task."),
      specialist_role: z
        .string()
        .optional()
        .describe(
          "Optional role, e.g. 'researcher', 'critic', 'writer', 'devil''s advocate', 'strategist'."
        ),
      model: z.string().default("claude-sonnet-4-5"),
      max_tokens: z.number().default(2048),
    },
    async ({ task, context, specialist_role, model, max_tokens }) => {
      try {
        const system = specialist_role
          ? `You are an expert ${specialist_role}. Your job is to help the orchestrating AI by completing the assigned task with precision and depth.`
          : "You are a helpful AI specialist collaborating with another AI agent. Complete the assigned task thoroughly.";

        const userContent = context
          ? `Task:\n${task}\n\nContext:\n${context}`
          : `Task:\n${task}`;

        const message = await anthropic.messages.create({
          model,
          max_tokens,
          system,
          messages: [{ role: "user", content: userContent }],
        });

        return toolText(extractText(message));
      } catch (err) {
        return toolError(`cowork failed: ${err?.message ?? String(err)}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 5. distill — extract signal from noise
  // -------------------------------------------------------------------------
  server.tool(
    "distill",
    "Distill content down to its essentials. Returns a SUMMARY, KEY POINTS, " +
      "ACTION ITEMS (if any), and a one-sentence INSIGHT.",
    {
      content: z.string().describe("The raw content to distill."),
      goal: z
        .string()
        .optional()
        .describe("Optional goal to focus the distillation."),
      model: z.string().default("claude-haiku-3-5"),
      max_tokens: z.number().default(1024),
    },
    async ({ content, goal, model, max_tokens }) => {
      try {
        const system =
          "You are a distillation engine. Extract signal from noise. Return: " +
          "SUMMARY (2-3 sentences), KEY POINTS (bullet list), ACTION ITEMS (if any), " +
          "INSIGHT (one sentence of your own reflection).";

        const userContent = goal
          ? `Goal: ${goal}\n\nContent to distill:\n${content}`
          : `Content to distill:\n${content}`;

        const message = await anthropic.messages.create({
          model,
          max_tokens,
          system,
          messages: [{ role: "user", content: userContent }],
        });

        return toolText(extractText(message));
      } catch (err) {
        return toolError(`distill failed: ${err?.message ?? String(err)}`);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// NOTE: We deliberately do NOT install express.json() globally. The
// SSEServerTransport reads the raw POST body itself in handlePostMessage();
// pre-parsing it would consume the stream and break message delivery.

/**
 * Bearer-token middleware. Applied to /sse and /messages only.
 * If AUTH_TOKEN is unset, auth is skipped entirely.
 */
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();

  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (token !== AUTH_TOKEN) {
    return res
      .status(401)
      .json({ error: "unauthorized", message: "Missing or invalid bearer token." });
  }
  next();
}

// Active SSE transports, keyed by sessionId.
const transports = new Map();

// --- Health probe (always open) -------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "claude-cowork-mcp",
    models: MODEL_IDS,
  });
});

// --- SSE stream ------------------------------------------------------------
app.get("/sse", requireAuth, async (req, res) => {
  try {
    // The transport writes the SSE handshake to `res` and exposes the
    // endpoint path clients should POST messages back to.
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    // Clean up when the client disconnects.
    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    // One McpServer per connection, then wire it to this transport.
    const server = createMcpServer();
    await server.connect(transport);
  } catch (err) {
    console.error("[claude-cowork-mcp] /sse error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "sse_setup_failed", message: String(err) });
    }
  }
});

// --- Inbound client messages ----------------------------------------------
app.post("/messages", requireAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    return res.status(404).json({
      error: "session_not_found",
      message: "No active SSE session for the provided sessionId.",
    });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("[claude-cowork-mcp] /messages error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "message_handling_failed", message: String(err) });
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[claude-cowork-mcp] listening on port ${PORT}`);
  console.log(`[claude-cowork-mcp] SSE endpoint:    GET  /sse`);
  console.log(`[claude-cowork-mcp] message endpoint: POST /messages?sessionId=...`);
  console.log(`[claude-cowork-mcp] health endpoint:  GET  /health`);
  console.log(
    `[claude-cowork-mcp] auth: ${AUTH_TOKEN ? "ENABLED (Bearer token)" : "DISABLED (no AUTH_TOKEN set)"}`
  );
});
