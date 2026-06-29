'use strict';
// Drives one website build on a Vertex AI Agent Engine (ADK agent crew).
//
// ADK semantics: a single stream_query turn ends at the first agent transfer,
// so a full crew run is driven as several explicit turns inside ONE session
// (create_session + phased stream_query). Every streamed event is surfaced —
// text parts AND function_call / function_response parts — because the
// sub-agents do their real work through tool calls; that is what makes the
// crew visibly "work" in the UI.
//
// Configuration (env):
//   AGENT_ENGINE_RESOURCE  projects/<p>/locations/<l>/reasoningEngines/<id>  (required)
//   AGENT_ENGINE_TIMEOUT_MS    per-turn timeout            (default 180000)
//   AGENT_ENGINE_RUN_BUDGET_MS whole-run wall clock budget (default 540000)

const { getAccessToken } = require('./token');
const { resolveProviderConfig } = require('./providerConfig');

// Provider dispatch (card Azz8fInK): resolve WHERE the engine authenticates —
// managed env by default, a per-tenant BYOK config when one is injected. With
// nothing injected this is exactly the prior env read.
const _provider = resolveProviderConfig();
const AGENT_ENGINE_RESOURCE = _provider.agentEngine.resource;
const AGENT_ENGINE_LOCATION = _provider.agentEngine.location;
const AGENT_ENGINE_TIMEOUT_MS = Number(process.env.AGENT_ENGINE_TIMEOUT_MS) || 180000;
const RUN_BUDGET_MS = Number(process.env.AGENT_ENGINE_RUN_BUDGET_MS) || 540000;

const ENABLED = !!AGENT_ENGINE_RESOURCE;

function hasHebrew(s) { return /[\u0590-\u05FF\uFB1D-\uFB4F]/.test(String(s == null ? '' : s)); }

// ---- event → readable chunks --------------------------------------------------
function agentEventChunks(event) {
  const out = [];
  if (typeof event === 'string') return event.trim() ? [event] : out;
  if (!event || typeof event !== 'object') return out;
  const content = event.content;
  if (content && typeof content === 'object' && Array.isArray(content.parts)) {
    for (const p of content.parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string' && p.text.trim()) out.push(p.text);
      const fc = p.function_call || p.functionCall;
      if (fc && typeof fc === 'object') {
        const name = fc.name || 'tool';
        const args = fc.args || fc.arguments || {};
        if (name === 'transfer_to_agent' && args && typeof args === 'object') {
          out.push('→ handing off to ' + (args.agent_name || args.agentName || '?'));
        } else {
          let argStr = '';
          try { argStr = Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', '); } catch { argStr = ''; }
          out.push(`🔧 ${name}(${argStr.length > 300 ? argStr.slice(0, 300) + '…' : argStr})`);
        }
      }
      const fr = p.function_response || p.functionResponse;
      if (fr && typeof fr === 'object') {
        const resp = fr.response;
        const payload = (resp && typeof resp === 'object' && 'result' in resp) ? resp.result : resp;
        if (payload != null && payload !== '' && !(typeof payload === 'object' && Object.keys(payload).length === 0)) {
          let s; try { s = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { s = String(payload); }
          out.push(s.length > 1200 ? s.slice(0, 1200) + ' …' : s);
        }
      }
    }
    if (out.length) return out;
  }
  for (const key of ['text', 'output', 'response']) {
    if (typeof event[key] === 'string' && event[key].trim()) out.push(event[key]);
  }
  return out;
}

function agentEventAuthor(event) {
  return (event && typeof event === 'object' && (event.author || event.agent)) || '';
}

// ---- spec extraction -----------------------------------------------------------
// String-aware brace scan: braces inside JSON string values never move the depth
// counter, so copy text like "open 9:00 {weekdays}" can't mis-bound a candidate.
// Returns the LAST spec-shaped object (one carrying a `business` key).
function extractSpecFromText(text) {
  const s = String(text || '');
  const spans = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; }
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { spans.push([start, i + 1]); start = -1; }
    }
  }
  for (let k = spans.length - 1; k >= 0; k--) {
    const cand = s.slice(spans[k][0], spans[k][1]);
    try { const obj = JSON.parse(cand); if (obj && obj.business) return obj; } catch { /* try earlier span */ }
  }
  return null;
}

// ---- the phased build conversation ----------------------------------------------
const SPEC_SCHEMA =
  '{"business":string,"tagline":string,"vibe":one of ["warm","fresh","modern","trust","bold"],' +
  '"layout":one of ["standard","services","catalog","booking"],"hero_emoji":string,' +
  '"about_heading":string,"about":string,"items_heading":string,' +
  '"items":[{"emoji":string,"name":string,"desc":string,"price":string}],' +
  '"why_heading":string,"why":[{"emoji":string,"title":string,"text":string}],' +
  '"cta_heading":string,"cta_text":string,"cta_button":string,' +
  '"contact":{"address":string,"phone":string,"email":string,"hours":string}}';

function buildEnginePhases(brief) {
  const he = brief.lang === 'he' || hasHebrew(brief.business) || hasHebrew(brief.description);
  const langRule = he
    ? 'The brief is in Hebrew — write ALL copy in Hebrew and add "lang":"he","dir":"rtl". '
    : 'Write ALL copy and ALL of your responses in English only. ';
  const schema = SPEC_SCHEMA + (he ? '. ' + langRule : '');
  // Real client media changes the design conversation: the layout agent plans
  // around the client's own photos/videos (hero + gallery) instead of stock.
  const photos = Number(brief.user_photos) || 0;
  const videos = Number(brief.user_videos) || 0;
  const mediaNote = (photos || videos)
    ? `\n\nThe client uploaded ${photos} of their own photo(s) and ${videos} video(s). ` +
      'The site will feature this real media as the hero image and a gallery section — ' +
      'have the layout agent design around the client\'s own imagery rather than stock art, ' +
      'and the copy agent write as if the visuals show the real business.'
    : '';
  return [
    'We are building a one-page marketing website from this business brief. ' + langRule +
    'Delegate to the research agent for a brand brief, then to the layout agent (Leo) ' +
    'for the block sequence. Do not publish.\n\nBusiness brief:\n' + JSON.stringify(brief) + mediaNote,
    'Continue the build: delegate to the copy agent (Noa) for copy per block' +
    (he ? ' (Hebrew first)' : ' (English only)') + ', then to the SEO agent (Sam) for the SEO score. Do not publish.',
    'Continue: delegate to the observability agent (Phoenix) to record this build run to ' +
    'Arize Phoenix via its MCP server, then stop at the approval gate. Do not publish.',
    'Without publishing: as the orchestrator, assemble everything the crew produced into ' +
    'the final site spec and return ONLY strict JSON (no markdown, no prose, no commentary) ' +
    'matching this schema: ' + schema + '.'
  ];
}

// ---- transport -----------------------------------------------------------------
async function createSession(token) {
  const r = await fetch(
    `https://${AGENT_ENGINE_LOCATION}-aiplatform.googleapis.com/v1/${AGENT_ENGINE_RESOURCE}:query`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'create_session', input: { user_id: 'builder' } }),
      signal: AbortSignal.timeout(20000)
    });
  if (!r.ok) throw new Error(`create_session failed (${r.status})`);
  const sj = await r.json();
  const id = (sj && sj.output && (sj.output.id || sj.output.session_id)) || null;
  if (!id) throw new Error('create_session returned no session id');
  return id;
}

// One engine turn, streamed INCREMENTALLY: events are parsed off the SSE body as
// bytes arrive and forwarded to onEvent immediately — the UI sees the crew work
// live, not in an end-of-turn burst.
async function engineTurn(token, message, sessionId, sink, timeoutMs, onEvent) {
  const url = `https://${AGENT_ENGINE_LOCATION}-aiplatform.googleapis.com/v1/${AGENT_ENGINE_RESOURCE}:streamQuery?alt=sse`;
  const input = { user_id: 'builder', message, session_id: sessionId };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'stream_query', input }),
    signal: AbortSignal.timeout(timeoutMs || AGENT_ENGINE_TIMEOUT_MS)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`agent-engine ${r.status}: ${txt.slice(0, 400)}`);
  }

  let count = 0;
  const handle = (ev) => {
    count++;
    const author = agentEventAuthor(ev);
    for (const chunk of agentEventChunks(ev)) {
      if (!chunk) continue;
      sink.allText += chunk + '\n';
      const step = { agent: author || 'agent', text: chunk.length > 2000 ? chunk.slice(0, 2000) + ' …' : chunk };
      sink.agentSteps.push(step);
      if (onEvent) { try { onEvent(step); } catch { /* listener errors never kill the run */ } }
    }
  };

  const parseLine = (line) => {
    line = line.trim();
    if (!line || line === '[DONE]') return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line) return;
    try { handle(JSON.parse(line)); } catch { /* partial / non-JSON line */ }
  };

  if (r.body && typeof r.body.getReader === 'function') {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        parseLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) parseLine(buf);
  } else {
    // Body not streamable in this runtime — fall back to whole-text parse.
    const txt = await r.text();
    const trimmed = txt.trim();
    if (trimmed.startsWith('[')) {
      try { for (const ev of JSON.parse(trimmed)) handle(ev); return count; } catch { /* fall through */ }
    }
    for (const line of trimmed.split('\n')) parseLine(line);
  }
  return count;
}

// Run the whole build. onStep(step, phaseIndex) fires for every surfaced chunk.
// Returns { spec, agentSteps }. Throws on failure — there is NO non-Google
// fallback path in this app, by design (hackathon: Google AI only).
async function runBuild(brief, onStep) {
  if (!ENABLED) throw new Error('AGENT_ENGINE_RESOURCE is not configured');
  const token = await getAccessToken();
  const deadline = Date.now() + RUN_BUDGET_MS;
  const phaseTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining < 5000) throw new Error('agent-engine: wall-clock budget exhausted');
    return Math.min(AGENT_ENGINE_TIMEOUT_MS, remaining - 2000);
  };

  const sessionId = await createSession(token);
  const sink = { agentSteps: [], allText: '' };
  let sawEvents = 0;
  const phases = buildEnginePhases(brief);
  for (let i = 0; i < phases.length; i++) {
    sawEvents += await engineTurn(token, phases[i], sessionId, sink, phaseTimeout(),
      onStep ? (s) => onStep(s, i) : null);
  }
  if (!sawEvents) throw new Error('agent-engine returned no events across all phases');

  let spec = extractSpecFromText(sink.allText);
  // The final-JSON turn is LLM-routed and occasionally returns prose. Retry up
  // to twice, repeating the schema each time (by the retry the model may have
  // lost it). Still nothing → return spec:null and let the caller fall back;
  // the demo must never die on a formatting wobble.
  const retryMsgs = [
    'Return ONLY the strict JSON site spec now — no prose, no markdown fences. It must match exactly this schema: ' + SPEC_SCHEMA + '.',
    'Your previous reply was not parseable JSON. Reply with exactly ONE JSON object and nothing else, matching: ' + SPEC_SCHEMA + '.'
  ];
  for (const msg of retryMsgs) {
    if (spec) break;
    sink.allText = '';
    try {
      await engineTurn(token, msg, sessionId, sink, phaseTimeout(),
        onStep ? (s) => onStep(s, phases.length) : null);
    } catch { break; }
    spec = extractSpecFromText(sink.allText);
  }
  return { spec: spec || null, agentSteps: sink.agentSteps };
}

// One standalone conversational turn (fresh session) — used by /api/ask so the
// client can talk to the live orchestrator. Returns the concatenated text.
async function oneTurn(message, timeoutMs) {
  if (!ENABLED) throw new Error('AGENT_ENGINE_RESOURCE is not configured');
  const token = await getAccessToken();
  const sessionId = await createSession(token);
  const sink = { agentSteps: [], allText: '' };
  await engineTurn(token, message, sessionId, sink, timeoutMs || 60000, null);
  const text = sink.agentSteps
    .map(s => s.text)
    .filter(t => t && !/^→|^🔧/.test(t))
    .join('\n').trim();
  if (!text) throw new Error('no reply from the orchestrator');
  return text;
}

module.exports = {
  ENABLED, runBuild, oneTurn, buildEnginePhases,
  agentEventChunks, agentEventAuthor, extractSpecFromText, hasHebrew
};
