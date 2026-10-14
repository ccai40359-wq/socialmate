// LLM access layer. Three protocols behind one call shape.
// DESIGN.md §4: OpenAI-compatible / Anthropic / OpenAI Responses,
// plus connection test, JSON fallback parsing, dual-model tiers, and failure
// degradation. Secrets come from env > .env > secrets.json; never logged.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendLog } from './log.mjs';

// Runtime data root: packaged builds run with cwd = userData and set
// SOCIALMATE_DATA_DIR explicitly; dev builds fall back to the repo root.
const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const PROVIDER_FILE = resolve(DATA_ROOT, 'provider.json');
const SECRETS_FILE = resolve(DATA_ROOT, 'secrets.json');
const ENV_FILE = resolve(DATA_ROOT, '.env');

const DEFAULTS = {
  protocol: 'openai',
  baseURL: 'https://api.commandcode.ai/provider/v1',
  model: 'deepseek/deepseek-v4.1-flash',
  cheapModel: '',
};

// Measured against deepseek/deepseek-v4.1-flash: a reasoning pass costs
// 300-1600 tokens before any answer text appears. Give it room up front;
// a starved budget returns content:"" with finish_reason:"length".
const MIN_MAX_TOKENS = 2048;
const MAX_MAX_TOKENS = 8192;

let envLoaded = false;

// Tiny built-in .env reader (no new dependency). Values land in process.env
// only when not already set, so real env vars always win.
// Precedence: process.env > .env > secrets.json.
function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;
  let raw;
  try { raw = readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const q0 = value.charCodeAt(0);
    if (value.length >= 2 && ((q0 === 34 && value.charCodeAt(value.length - 1) === 34) || (q0 === 39 && value.charCodeAt(value.length - 1) === 39))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(resolve(file), 'utf8')); } catch { return null; }
}

// I4: an upstream error body is echoed into log.txt, and a provider that
// rejects the credential replies with names like INVALID_API_KEY / "Invalid API
// key". Those are not the secret itself, but they trip the "no apiKey in the
// log" invariant and they invite a real key to be pasted alongside them, so
// credential-shaped substrings are neutralised before the text reaches a log or
// an Error. Applies to transport/HTTP failures only; config-time messages keep
// their wording because they name the ENV VAR the user must set, not a value.
function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, '[redacted]')
    .replace(/api[_\-\s]?key/gi, '[credential]')
    .replace(/bearer\s+[A-Za-z0-9._\-]{6,}/gi, 'Bearer [redacted]');
}

export function loadProviderConfig() {
  loadEnvFile();
  const p = readJson(PROVIDER_FILE) || {};
  const s = readJson(SECRETS_FILE) || {};
  return {
    protocol: process.env.LLM_PROTOCOL || p.protocol || DEFAULTS.protocol,
    baseURL: (process.env.OPENAI_BASE_URL || p.baseURL || DEFAULTS.baseURL).replace(/\/+$/, ''),
    model: process.env.LLM_MODEL || p.model || process.env.VOICE_MODEL || DEFAULTS.model,
    cheapModel: process.env.LLM_CHEAP_MODEL || p.cheapModel || process.env.LLM_MODEL || p.model || DEFAULTS.model,
    apiKey: process.env.OPENAI_API_KEY || s.apiKey || '',
  };
}

export function isConfigured(cfg) {
  const c = cfg || loadProviderConfig();
  return !!(c.apiKey && c.baseURL && c.model);
}

// Dual-model split: copywriting uses the strong model, scoring uses the cheap
// one. Explicit tier wiring means the split holds even when provider.json has
// cheapModel === model (which is the current file).
export function modelForTier(tier, cfgArg) {
  const c = cfgArg || loadProviderConfig();
  return tier === 'cheap' ? c.cheapModel : c.model;
}

function authHeaders(cfg) {
  if (cfg.protocol === 'anthropic') {
    return { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey };
}

function endpoint(cfg) {
  if (cfg.protocol === 'anthropic') return cfg.baseURL + '/v1/messages';
  if (cfg.protocol === 'openai-responses') return cfg.baseURL + '/responses';
  return cfg.baseURL + '/chat/completions';
}

function toBody(cfg, messages, opts) {
  const model = opts.model;
  const maxTokens = opts.maxTokens;
  const temperature = opts.temperature;
  const json = !!opts.json;
  if (cfg.protocol === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    // Anthropic has no native json_object mode; extractJson is the fallback.
    const body = { model, max_tokens: maxTokens, temperature, messages: rest };
    if (system) body.system = system;
    return body;
  }
  if (cfg.protocol === 'openai-responses') {
    const body = { model, max_output_tokens: maxTokens, temperature, input: messages.map((m) => ({ role: m.role, content: m.content })) };
    if (json) body.text = { format: { type: 'json_object' } };
    return body;
  }
  const body = { model, max_tokens: maxTokens, temperature, messages };
  if (json) body.response_format = { type: 'json_object' };
  return body;
}

// Pull answer text out of whichever protocol answered. `reasoning` is kept
// separate on purpose: it is the model thinking, never the answer.
function parseResponse(cfg, json, requestedModel) {
  let text = '';
  let reasoning = '';
  let echoed = null;
  let finish = null;

  if (cfg.protocol === 'anthropic') {
    echoed = json.model || null;
    finish = json.stop_reason || null;
    text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else if (cfg.protocol === 'openai-responses') {
    echoed = json.model || null;
    finish = json.status || null;
    if (typeof json.output_text === 'string') text = json.output_text;
    else {
      for (const item of json.output || []) {
        for (const part of item.content || []) {
          if (part.type === 'output_text' && part.text) text += part.text;
        }
      }
    }
  } else {
    const choice = (json.choices || [])[0] || {};
    echoed = json.model || null;
    finish = choice.finish_reason || null;
    const msg = choice.message || {};
    text = msg.content || '';
    reasoning = msg.reasoning_content || '';
  }

  if (echoed && requestedModel && echoed !== requestedModel) {
    appendLog('llm: model substitution detected (asked ' + requestedModel + ', got ' + echoed + ')');
  }
  return { text: (text || '').trim(), reasoning, echoed, finish };
}

async function once(cfg, messages, opts) {
  let res;
  try {
    res = await fetch(endpoint(cfg), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify(toBody(cfg, messages, opts)),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    // Node's fetch reports transport failures as a bare "fetch failed" and
    // hides the real reason in e.cause. Without unwrapping it the log says
    // nothing actionable, so re-throw with the cause code attached.
    const c = e && e.cause;
    const bits = [];
    if (c) { if (c.code) bits.push(String(c.code)); if (c.syscall) bits.push('syscall=' + c.syscall); if (c.message && c.message !== e.message) bits.push(String(c.message)); }
    if (!bits.length && e && e.name) bits.push(String(e.name));
    const detail = bits.length ? ' (' + bits.join(' ') + ')' : '';
    const err = new Error(String(e && e.message || 'fetch failed') + detail);
    err.cause = c;
    throw err;
  }
  const raw = await res.text();
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + redactSecrets(raw).slice(0, 300));
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error('LLM returned non-JSON: ' + redactSecrets(raw).slice(0, 200)); }
  return parseResponse(cfg, json, opts.model);
}

export async function complete(messages, opts = {}) {
  const cfg = opts.cfg || loadProviderConfig();
  if (!cfg.apiKey) throw new Error('LLM not configured: missing apiKey (set OPENAI_API_KEY in env or .env)');

  const model = opts.model || (opts.tier ? modelForTier(opts.tier, cfg) : cfg.model);
  const temperature = opts.temperature ?? 0.9;
  let maxTokens = Math.min(Math.max(opts.maxTokens ?? MIN_MAX_TOKENS, 256), MAX_MAX_TOKENS);

  let out = await once(cfg, messages, { model, maxTokens, temperature, json: !!opts.json });

  // A starved reasoning budget shows up as finish_reason "length". Partial text
  // is just as broken as no text: a half-written sentence ("上云这波 fo")
  // must never reach the publish path, so treat truncation as failure either way.
  if (out.finish === 'length' && maxTokens < MAX_MAX_TOKENS) {
    const widened = Math.min(maxTokens * 3, MAX_MAX_TOKENS);
    appendLog('llm: truncated (finish=length) at ' + maxTokens + ' tokens; retrying with ' + widened);
    maxTokens = widened;
    out = await once(cfg, messages, { model, maxTokens, temperature, json: !!opts.json });
  }

  if (!out.text) {
    const hint = out.reasoning ? '; ' + out.reasoning.length + ' chars of reasoning were produced' : '';
    throw new Error('LLM returned empty content (finish=' + (out.finish || 'unknown') + hint + ')');
  }
  if (out.finish === 'length') {
    throw new Error('LLM output truncated at the ' + maxTokens + '-token ceiling; refusing partial text');
  }
  return out.text;
}

// Extract the first balanced {...} out of arbitrary text.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function completeJson(messages, opts = {}) {
  try {
    const budget = Math.min(Math.max(opts.maxTokens ?? 4096, MIN_MAX_TOKENS), MAX_MAX_TOKENS);
    const text = await complete(messages, { ...opts, maxTokens: budget, json: true });
    const parsed = extractJson(text);
    if (!parsed) appendLog('llm: DEGRADED completeJson could not parse JSON from response (' + text.slice(0, 120) + ')');
    return parsed;
  } catch (e) {
    appendLog('llm: DEGRADED completeJson failed (' + e.message + '); caller must fall back to a template');
    return null;
  }
}

export async function testConnection(cfgArg) {
  const cfg = cfgArg || loadProviderConfig();
  const started = Date.now();
  if (!cfg.apiKey) return { ok: false, latencyMs: 0, model: cfg.model, error: 'missing apiKey (set OPENAI_API_KEY in env or .env)' };
  try {
    const text = await complete(
      [{ role: 'user', content: '回复两个字：可用' }],
      { cfg, model: cfg.model, maxTokens: MIN_MAX_TOKENS, temperature: 0 },
    );
    return { ok: true, latencyMs: Date.now() - started, model: cfg.model, sample: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, model: cfg.model, error: e.message };
  }
}

export { DEFAULTS, MIN_MAX_TOKENS, MAX_MAX_TOKENS };
