/**
 * Nexus — Anthropic API proxy
 * Vercel serverless function: /api/claude
 *
 * Keeps the API key server-side only.
 * Accepts POST with { system, messages, max_tokens }
 * Returns the Anthropic response as-is.
 */

export const config = {
  runtime: 'edge', // Edge runtime — faster cold starts, global CDN
};

const ALLOWED_ORIGINS = [
  'https://pillrz.com',
  'https://www.pillrz.com',
  // add preview URLs while testing, e.g. 'https://nexus-pillrz.vercel.app'
];

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-20250514';

// Simple rate limiting via in-memory store (resets on cold start)
// For production, swap this for Upstash Redis or Vercel KV
const ipCounts = new Map();
const RATE_LIMIT  = 20;   // max requests per window
const RATE_WINDOW = 60_000; // 1 minute in ms

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipCounts.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    ipCounts.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  ipCounts.set(ip, entry);
  return true;
}

export default async function handler(req) {
  // CORS preflight
  const origin = req.headers.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  const corsHeaders = {
    'Access-Control-Allow-Origin':  isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // Rate limit
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ error: 'Rate limit reached. Please wait a moment.' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body.' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { system, messages, max_tokens } = body;

  if (!system || !messages || !Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: system, messages.' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Guard max_tokens — cap at 1200 to control costs
  const safeMaxTokens = Math.min(Number(max_tokens) || 1000, 1200);

  // Forward to Anthropic
  try {
    const anthropicResp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            process.env.ANTHROPIC_API_KEY,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: safeMaxTokens,
        system,
        messages,
      }),
    });

    const data = await anthropicResp.json();

    if (!anthropicResp.ok) {
      console.error('Anthropic error:', data);
      return new Response(
        JSON.stringify({ error: data?.error?.message || 'Anthropic API error.' }),
        { status: anthropicResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Proxy error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
