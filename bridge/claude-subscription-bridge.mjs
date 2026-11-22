#!/usr/bin/env node
// Claude subscription bridge for Dossier.
//
// Dossier talks to Claude through the Anthropic Messages API, which needs a
// pay-as-you-go API key. This bridge runs on your own machine, next to the
// Claude Code CLI you're signed in to with your Claude Pro/Max plan, and
// answers the few Messages API calls Dossier makes by running
// `claude -p` (headless Claude Code). No API key, no API credit: every call
// counts against your subscription's usage limits instead.
//
// In Dossier, choose Settings → AI provider → Anthropic, set the address to
// http://host.docker.internal:8787 (or http://localhost:8787 when Dossier
// isn't in Docker) and use BRIDGE_TOKEN as the API key.
//
// No dependencies: Node 20+ and the `claude` CLI on PATH.

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
// 127.0.0.1 is enough for Docker Desktop (Mac/Windows): host.docker.internal
// reaches the host's loopback. On Linux Docker, use 0.0.0.0 and keep the token.
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const MAX_CONCURRENT = Math.max(1, Number(process.env.BRIDGE_MAX_CONCURRENT ?? 2));
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_SECONDS ?? 600) * 1000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MODELS = (process.env.BRIDGE_MODELS ?? "claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("Set BRIDGE_TOKEN to a long random string; Dossier sends it as its \"API key\".");
  console.error('  e.g. BRIDGE_TOKEN="$(openssl rand -hex 24)" node bridge/claude-subscription-bridge.mjs');
  process.exit(1);
}

// An empty folder for every run, so no CLAUDE.md or project settings leak in.
const WORKDIR = mkdtempSync(join(tmpdir(), "dossier-claude-bridge-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

// ---------- a small queue, so a burst of AI jobs doesn't start ten CLIs ----------

let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ---------- Messages API → claude -p ----------

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block?.type === "text" ? block.text : "")).join("")
      : "";

const systemOf = (system) => (typeof system === "string" ? system : textOf(system));

/** One prompt from the whole conversation; Dossier's are one user message, or three on a JSON retry. */
function promptOf(messages) {
  if (messages.length === 1 && messages[0].role === "user") return textOf(messages[0].content);
  const turns = messages.map((m) => `<${m.role}>\n${textOf(m.content)}\n</${m.role}>`).join("\n\n");
  return `Here is our conversation so far:\n\n${turns}\n\nReply to the last user message.`;
}

class BridgeError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function classify(text) {
  if (/not logged in|please run \/login|invalid api key|authentication|oauth/i.test(text))
    return new BridgeError(401, "authentication_error", `Claude Code isn't signed in on this machine: run \`claude\` and /login. (${text})`);
  if (/usage limit|rate limit|limit reached|too many requests/i.test(text)) return new BridgeError(429, "rate_limit_error", text);
  if (/overloaded/i.test(text)) return new BridgeError(529, "overloaded_error", text);
  if (/prompt is too long|context (window|length)/i.test(text)) return new BridgeError(400, "invalid_request_error", `prompt is too long: ${text}`);
  return new BridgeError(400, "api_error", text || "Claude Code failed without a message.");
}

function runClaude({ model, system, prompt, schema }, abortSignal) {
  const id = randomUUID();
  const systemFile = join(WORKDIR, `${id}.system.txt`);
  writeFileSync(systemFile, system || "You are a helpful assistant.");
  const args = [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--system-prompt-file", systemFile,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (schema) args.push("--json-schema", JSON.stringify(schema));

  // Without the API key variables, Claude Code uses your subscription login.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(kill, TIMEOUT_MS);
    abortSignal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rmSync(systemFile, { force: true });
      reject(new BridgeError(500, "api_error", `Couldn't start ${CLAUDE_BIN}: ${error.message}. Is Claude Code installed and on PATH?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", kill);
      rmSync(systemFile, { force: true });
      if (abortSignal.aborted) return reject(new BridgeError(499, "api_error", "cancelled"));
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(classify((stderr || stdout).trim() || `claude exited with code ${code}`));
      }
      if (result.is_error || result.subtype !== "success") {
        return reject(classify(String(result.result ?? result.subtype ?? stderr).trim()));
      }
      resolve(result);
    });
    child.stdin.end(prompt);
  });
}

async function createMessage(body, abortSignal) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0)
    throw new BridgeError(400, "invalid_request_error", "messages: at least one message is required");
  const model = body.model || MODELS[0];
  const format = body.output_config?.format;
  const schema = format?.type === "json_schema" ? format.schema : undefined;

  const result = await withSlot(() =>
    runClaude({ model, system: systemOf(body.system), prompt: promptOf(body.messages), schema }, abortSignal),
  );

  const text = schema && result.structured_output !== undefined ? JSON.stringify(result.structured_output) : String(result.result ?? "");
  const usage = result.usage ?? {};
  return {
    id: `msg_bridge_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: result.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    },
  };
}

// ---------- HTTP ----------

const modelInfo = (id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" });

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "request-id": `req_bridge_${randomUUID()}` });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const status = error instanceof BridgeError ? error.status : 500;
  const type = error instanceof BridgeError ? error.type : "api_error";
  if (status !== 499) console.error(`[bridge] ${status} ${type}: ${error.message}`);
  if (!res.headersSent && !res.destroyed) send(res, status, { type: "error", error: { type, message: error.message } });
}

function authorized(req) {
  const given = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, "request_too_large", "Request body too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError(400, "invalid_request_error", "Body isn't valid JSON.");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bridge");
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && (path === "" || path === "/health")) return send(res, 200, { ok: true });
    if (!authorized(req)) throw new BridgeError(401, "authentication_error", "invalid x-api-key: use the bridge's BRIDGE_TOKEN as the API key.");

    if (req.method === "GET" && path === "/v1/models") {
      const data = MODELS.map(modelInfo);
      return send(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      // No `capabilities`: Dossier then sends no effort setting, which the CLI can't take per call anyway.
      return send(res, 200, modelInfo(decodeURIComponent(path.slice("/v1/models/".length))));
    }
    if (req.method === "POST" && path === "/v1/messages") {
      const body = await readJson(req);
      if (body.stream) throw new BridgeError(400, "invalid_request_error", "Streaming isn't supported by this bridge.");
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const started = Date.now();
      const message = await createMessage(body, abort.signal);
      console.log(`[bridge] ${message.model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s (${message.usage.output_tokens} output tokens)`);
      return send(res, 200, message);
    }
    throw new BridgeError(404, "not_found_error", `${req.method} ${path} isn't supported by this bridge.`);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude subscription bridge listening on http://${HOST}:${PORT}`);
  console.log(`  models: ${MODELS.join(", ")}   concurrency: ${MAX_CONCURRENT}   timeout: ${TIMEOUT_MS / 1000}s`);
  console.log("  In Dossier: Settings → AI provider → Anthropic, address http://host.docker.internal:" + PORT + ", API key = BRIDGE_TOKEN");
});
