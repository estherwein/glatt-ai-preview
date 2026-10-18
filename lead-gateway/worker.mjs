import '../assets/leads-core.js';

const core = globalThis.GlattLeads;
const MAX_BODY_BYTES = 16384;
const encoder = new TextEncoder();

export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Enforce the actual stream size; Content-Length alone is untrusted.
export async function readLimited(message, limit) {
  if (Number(message.headers.get('Content-Length')) > limit) core.fail('TOO_LARGE');
  if (!message.body) return '';
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); core.fail('TOO_LARGE'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Vary': 'Origin'
  };
}
function response(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {status, headers: {
    ...headers, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  }});
}

// The injectable fetch is used only by local tests, never configured by the visitor.
export async function handleRequest(request, env, upstreamFetch = fetch) {
  let headers = {};
  try {
    if (env.ENVIRONMENT !== 'preview' || env.ENABLED !== 'true') return response({ok:false, code:'UNAVAILABLE'}, 503);
    const origin = request.headers.get('Origin') || '';
    if (!core.allowedOrigin(origin, JSON.parse(env.ALLOWED_ORIGINS || '[]'))) return response({ok:false, code:'FORBIDDEN'}, 403);
    headers = cors(origin);
    const url = new URL(request.url);
    if (url.pathname !== '/leads' || url.search) return response({ok:false, code:'NOT_FOUND'}, 404, headers);
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Access-Control-Request-Method') !== 'POST' ||
          (request.headers.get('Access-Control-Request-Headers') || '').split(',').some(h => h.trim() && h.trim().toLowerCase() !== 'content-type')) {
        return response({ok:false, code:'FORBIDDEN'}, 403, headers);
      }
      return new Response(null, {status:204, headers});
    }
    if (request.method !== 'POST') return response({ok:false, code:'METHOD_NOT_ALLOWED'}, 405, headers);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return response({ok:false, code:'INVALID_INPUT'}, 415, headers);
    if (!/^[0-9a-f]{64}$/i.test(env.HMAC_SECRET || '') ||
        !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env.APPS_SCRIPT_URL || '') ||
        !env.LEAD_RATE_LIMITER || !env.GLOBAL_RATE_LIMITER) core.fail('UNAVAILABLE');

    // No in-memory counters and no raw IPs in application logs or Sheets.
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) core.fail('UNAVAILABLE');
    const rateKey = await hmac(env.HMAC_SECRET, 'rate-ip\n' + ip);
    const global = await env.GLOBAL_RATE_LIMITER.limit({key:'preview-leads'});
    const individual = await env.LEAD_RATE_LIMITER.limit({key:rateKey});
    if (!global.success || !individual.success) return response({ok:false, code:'RATE_LIMITED'}, 429, {...headers, 'Retry-After':'60'});

    let input;
    try { input = JSON.parse(await readLimited(request, MAX_BODY_BYTES)); }
    catch (error) { core.fail(error.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_INPUT'); }
    if (!input || typeof input !== 'object') core.fail('INVALID_INPUT');
    const requestId = core.requestId(input.requestId);
    core.spam(input);
    const lead = core.lead(input.lead, origin);
    const envelope = {
      version: 1, environment: 'preview', timestamp: Date.now(), requestId,
      payload: JSON.stringify({origin, lead, website:input.website, elapsedMs:input.elapsedMs})
    };
    // Apps Script doPost cannot read arbitrary request headers: all signed data is in the body.
    envelope.signature = await hmac(env.HMAC_SECRET, core.signingText(envelope));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let result;
    try {
      const upstream = await upstreamFetch(env.APPS_SCRIPT_URL, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(envelope),
        redirect:'follow', signal:controller.signal
      });
      if (!upstream.ok) core.fail('UPSTREAM_ERROR');
      result = JSON.parse(await readLimited(upstream, 4096));
    } catch (_) { return response({ok:false, code:'UPSTREAM_ERROR'}, 502, headers); }
    finally { clearTimeout(timer); }
    if (result && result.ok === true && result.saved === true && result.requestId === requestId &&
        typeof result.leadId === 'string' && /^[0-9a-f-]{36}$/i.test(result.leadId)) {
      return response({ok:true, saved:true, requestId, leadId:result.leadId}, 200, headers);
    }
    const safeErrors = {INVALID_INPUT:400, SPAM_REJECTED:400, ID_CONFLICT:409, BUSY:503};
    const code = result && Object.hasOwn(safeErrors, result.code) ? result.code : 'UPSTREAM_ERROR';
    return response({ok:false, code}, safeErrors[code] || 502, headers);
  } catch (error) {
    const statuses = {INVALID_INPUT:400, INVALID_REQUEST_ID:400, SPAM_REJECTED:400, TOO_LARGE:413};
    const code = Object.hasOwn(statuses, error.code) ? error.code : 'UNAVAILABLE';
    // Never return/log upstream bodies, input data, secrets or raw exception messages.
    return response({ok:false, code}, statuses[code] || 503, headers);
  }
}

export default {fetch: (request, env) => handleRequest(request, env)};
