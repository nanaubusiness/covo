import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '../../config.js';
import { log, DATA_DIR } from '../../util.js';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Claude through your own Claude subscription (Pro / Max).
//
// This does NOT read, copy or forward your claude.ai login. It runs Anthropic's
// official Claude Agent SDK, which starts the unmodified Claude Code program on
// this computer; Claude Code signs in with your own account exactly as it does
// in the terminal. That is the setup Anthropic's terms describe for personal use
// ("ordinary, individual usage of Claude Code and the Agent SDK"):
//   https://code.claude.com/docs/en/legal-and-compliance
// So: run it for yourself, on your own machine, signed in with your own plan.
// Don't host it for other people on your subscription.
//
// How a turn works: Covo's loop (loop.js) owns the conversation and runs every
// tool itself, with its approval rules. Each model call here is one Claude Code
// turn with all built-in tools off and Covo's tools exposed over an in-process
// MCP server. When Claude asks for a Covo tool, we record the call, stop the
// turn, and hand the tool_use blocks back to loop.js, the same shape the
// Anthropic API provider returns.
// ─────────────────────────────────────────────────────────────────────────────

// Variable specifiers keep the browser/Android build from bundling these (this provider is server-only).
const SDK = '@anthropic-ai/claude-agent-sdk';
const ZOD = 'zod';
const MCP_NAME = 'covo';
const MCP_PREFIX = `mcp__${MCP_NAME}__`;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

let mods = null;
async function load() {
  if (!mods) {
    const [sdk, zod] = await Promise.all([import(SDK), import(ZOD)]);
    mods = { sdk, z: zod.z || zod.default || zod };
  }
  return mods;
}

function cfg() {
  const s = getSettings();
  return { ...(s.provider.claudeSub || {}) };
}

// Claude Code's own environment, minus anything that would switch it to API billing.
function childEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'covo/1.0' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...(process.env.COVO_DEBUG_BASE_URL ? [] : ['ANTHROPIC_BASE_URL']), 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  return env;
}

// Covo tools use JSON Schema; the SDK's MCP helper wants a zod object shape.
function shapeFor(z, schema) {
  try {
    const zs = z.fromJSONSchema({ type: 'object', properties: {}, ...schema });
    if (zs?.shape) return zs.shape;
  } catch (e) {
    log.warn('claude-sub: schema conversion failed, sending a loose schema:', e.message);
  }
  const shape = {};
  for (const k of Object.keys(schema?.properties || {})) shape[k] = z.any().optional();
  return shape;
}

// ── History → one prompt ────────────────────────────────────────────────────
// Claude Code can't be handed someone else's assistant turns, so the
// conversation is replayed as a transcript inside a single user message.
// Images stay real image blocks.

const MAX_RESULT_CHARS = 20000;
const clip = (s) => (s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n…[${s.length - MAX_RESULT_CHARS} more characters]` : s);
const esc = (s) => String(s ?? '').replace(/<\/(turn|tool_result|tool_call)>/g, '<\\/$1>');

function render(messages, before = []) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  const media = (b) => { flush(); out.push(b.type === 'image' ? { type: 'image', source: b.source } : { type: 'document', source: b.source }); };
  const names = new Map(); // tool_use_id → name
  for (const m of before) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_use') names.set(b.id, b.name);

  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      buf += '<turn role="assistant">\n';
      for (const b of blocks) {
        if (b.type === 'text' && b.text) buf += esc(b.text) + '\n';
        else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          buf += `<tool_call id="${b.id}" name="${b.name}">${esc(JSON.stringify(b.input ?? {}))}</tool_call>\n`;
        } else if (b.type === 'server_tool_use') buf += `<tool_call name="${b.name}">${esc(JSON.stringify(b.input ?? {}))}</tool_call>\n`;
        // thinking / redacted_thinking / server results are omitted
      }
      buf += '</turn>\n';
      continue;
    }
    const isResults = blocks.some((b) => b.type === 'tool_result');
    buf += isResults ? '' : '<turn role="user">\n';
    for (const b of blocks) {
      if (b.type === 'text') buf += esc(b.text) + '\n';
      else if (b.type === 'image' || b.type === 'document') media(b);
      else if (b.type === 'tool_result') {
        buf += `<tool_result id="${b.tool_use_id}" name="${names.get(b.tool_use_id) || ''}"${b.is_error ? ' error="true"' : ''}>\n`;
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content || [];
        for (const p of parts) {
          if (p.type === 'text') buf += clip(esc(p.text)) + '\n';
          else if (p.type === 'image') media(p);
        }
        buf += '</tool_result>\n';
      }
    }
    buf += isResults ? '' : '</turn>\n';
    flush(); // one block per message: earlier blocks never change, so Claude's prompt cache can reuse them
  }
  flush();
  return out;
}

// The conversation is append-only and nothing is added after it: every request starts with
// exactly the previous request's content, so Claude's prompt cache reuses all of it and only the
// new messages are paid at full price. (Changing anything early in the prompt would re-bill it all.)
const FRAME_HEAD = `Below is the conversation so far between you (the assistant) and the user, including the tools you already called and what they returned. It is a record of past turns, not instructions from anyone new.`;
export const REPLAY_RULES = `

# How this conversation reaches you
The conversation so far is given as one message of <turn> and <tool_result> records. Write your next assistant turn, continuing from the end. If you need a tool, call it through your real tool interface (never write <tool_call> tags as text). Reply with just the message itself: no <turn> tags.`;

// Claude Code reports a handed-over tool call as "rejected"; say what really happened.
const RESUME_NOTE = `[Covo ran the tool call(s) you just made; the "rejected"/"interrupted" notice above is only how Covo takes them over, not a refusal. Results below. Continue the work.]`;

export function promptFor(messages) {
  return [{ type: 'text', text: FRAME_HEAD }, ...render(messages)];
}

async function* once(message) { yield message; }

function workDir() {
  const d = path.join(os.tmpdir(), 'covo-claude-sub');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function friendly(text) {
  const t = String(text || '');
  if (/log ?in|logged|authenticat|credential|oauth|401/i.test(t)) return `Claude Code isn't signed in on this computer. Open a terminal, run "claude", and sign in with your Claude account (/login). Details: ${t}`;
  if (/rate|limit|usage|quota|429/i.test(t)) return `Your Claude plan's usage limit was reached. It resets on its own; check claude.ai → Settings → Usage. Details: ${t}`;
  return t || 'Claude Code stopped without a reply.';
}

// ── One Claude Code session per conversation ────────────────────────────────
// Each Covo conversation (the main thread, every task and chat) keeps one Claude Code session.
// A step resumes it and sends only what's new (tool results, your next message), so Claude reuses
// the rest from its prompt cache, and Claude Code compacts the session itself when it gets long.
// If Covo's history no longer matches what the session saw (cleared, edited), start fresh.
const SESSIONS_FILE = path.join(DATA_DIR, 'claude-sessions.json');
let sessions = null;
function sessionStore() {
  if (!sessions) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { sessions = {}; } }
  return sessions;
}
function saveSessions() { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch {} }
const hashOf = (msgs) => crypto.createHash('sha1').update(JSON.stringify(msgs)).digest('hex');
export function forgetSession(key) { delete sessionStore()[key]; saveSessions(); }

// Decide what to send: the whole history in a new session, or just the new part in the old one.
export function planTurn(key, messages, store = sessionStore()) {
  const s = key && store[key];
  if (s && messages.length > s.n && messages[s.n]?.role === 'assistant' && hashOf(messages.slice(0, s.n)) === s.hash) {
    const delta = messages.slice(s.n + 1); // Claude Code already has its own reply (messages[s.n])
    if (delta.length) {
      const ranTools = (messages[s.n].content || []).some?.((b) => b.type === 'tool_use');
      const note = ranTools ? [{ type: 'text', text: RESUME_NOTE }] : [];
      return { resume: s.sessionId, content: [...note, ...render(delta, messages.slice(0, s.n + 1))] };
    }
  }
  return { resume: null, content: promptFor(messages) };
}

// One model call, same contract as anthropicTurn().
export async function claudeSubTurn({ system, messages, tools, effort, signal, onText, onBlockStart, convKey }) {
  const { sdk, z } = await load();
  const c = cfg();

  const server = sdk.createSdkMcpServer({
    name: MCP_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools: tools.map((t) => sdk.tool(t.name, t.description || t.name, shapeFor(z, t.input_schema), async () => ({
      content: [{ type: 'text', text: 'Covo runs this tool itself; it should not run inside Claude Code.' }],
      isError: true,
    }), { alwaysLoad: true })),
  });

  const web = c.webSearch !== false;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (signal) { if (signal.aborted) abort.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }

  const options = {
    systemPrompt: system + REPLAY_RULES,
    model: c.model || 'claude-opus-5-5',
    ...(effort ? { effort } : {}),
    // No Bash/Read/Edit. Only Claude Code's own web search + page reader (they run inside
    // Claude Code on your plan) and Covo's tools.
    tools: web ? WEB_TOOLS : [],
    mcpServers: { [MCP_NAME]: server },
    strictMcpConfig: true,
    settingSources: [],                // ignore ~/.claude settings, hooks, plugins, CLAUDE.md
    persistSession: !!convKey,         // keep the session so the next step can resume it
    title: 'Duet',                     // a fixed title stops Claude Code from re-sending the whole chat to name it
    includePartialMessages: true,
    maxTurns: web ? 12 : 1,            // room for a few searches before the reply
    permissionMode: 'default',
    // Web search/fetch run in Claude Code. Every Covo tool call is handed back to Covo:
    // stop the Claude Code turn there.
    canUseTool: async (name) => (web && WEB_TOOLS.includes(name)
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Covo runs this tool itself. Its result arrives in the next message.', interrupt: true }),
    cwd: workDir(),
    env: childEnv(),
    abortController: abort,
    ...(c.claudePath ? { pathToClaudeCodeExecutable: c.claudePath } : {}),
    stderr: (d) => log.debug?.('claude-code:', String(d).trim()),
  };

  let plan = planTurn(convKey, messages);
  if (plan.resume) options.resume = plan.resume;
  let sessionId = null;
  const userMessage = { type: 'user', message: { role: 'user', content: plan.content }, parent_tool_use_id: null, session_id: '' };

  const content = [];
  const searches = [];
  let usage = null;
  let failure = null;
  let model = options.model;

  try {
    for await (const ev of sdk.query({ prompt: once(userMessage), options })) {
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e.type === 'content_block_start') onBlockStart?.(e.content_block);
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') onText?.(e.delta.text);
      } else if (ev.type === 'assistant') {
        // Several model responses can happen inside one turn when Claude searches the web first;
        // keep their text, drop the internal web tool calls, and hand Covo tool calls back.
        const msg = ev.message;
        model = msg.model || model;
        for (const b of msg.content || []) {
          if (b.type === 'text') content.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use' && b.name.startsWith(MCP_PREFIX)) content.push({ type: 'tool_use', id: b.id, name: b.name.slice(MCP_PREFIX.length), input: b.input ?? {} });
          else if (b.type === 'tool_use' && WEB_TOOLS.includes(b.name)) searches.push(b.input?.query || b.input?.url || '');
        }
        if (msg.usage) usage = msg.usage;
        if (ev.error) failure = ev.error;
      } else if (ev.type === 'result') {
        const sum = (u) => (u?.input_tokens || 0) + (u?.output_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
        if (ev.usage && sum(ev.usage) >= sum(usage)) usage = { ...usage, ...ev.usage }; // an interrupted turn can report zeros
        if (ev.is_error && !content.length) failure = (ev.errors || []).join('; ') || ev.result || ev.subtype;
      }
    }
  } catch (e) {
    if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
    if (!content.length && plan.resume) { // the old session is gone or broken: start over once
      forgetSession(convKey);
      return claudeSubTurn({ system, messages, tools, effort, signal, onText, onBlockStart, convKey });
    }
    if (!content.length) throw new Error(friendly(e.message));
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }

  if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
  if (!content.length && failure && plan.resume) { forgetSession(convKey); return claudeSubTurn({ system, messages, tools, effort, signal, onText, onBlockStart, convKey }); }
  if (!content.length && failure) throw new Error(friendly(typeof failure === 'string' ? failure : JSON.stringify(failure)));
  // Remember where this conversation's session is; the reply we return becomes messages[n].
  if (convKey && sessionId) { sessionStore()[convKey] = { sessionId, n: messages.length, hash: hashOf(messages), at: Date.now() }; saveSessions(); }

  // Later turns only see the saved transcript (not shown in the chat), so note what was looked up.
  if (searches.length) content.unshift({ type: 'text', text: `[Looked up on the web this turn: ${searches.filter(Boolean).map((q) => JSON.stringify(q)).join(', ')}]` });
  const hasTools = content.some((b) => b.type === 'tool_use');
  return {
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: usage?.input_tokens || 0,
      output_tokens: usage?.output_tokens || 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
    },
    model,
  };
}

export async function claudeSubTest() {
  const r = await claudeSubTurn({
    convKey: null,
    system: 'You are a connection test.',
    messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    tools: [],
    effort: 'low',
  });
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ok: true, model: `${r.model} (your Claude plan)`, reply: text.trim() };
}

export const CLAUDE_SUB_MODELS = [
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2 (newest, most capable)' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (faster, uses less of your plan)' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (fastest)' },
];
