/**
 * Pochi TURN credential broker — with a monthly usage cap.
 *
 * Pochi is a static, backend-less app (GitHub Pages + a WebView2 desktop shell), but
 * Cloudflare's TURN service issues *short-lived* credentials that must be minted by
 * something holding the long-term TURN key secret — which can't live in client code.
 * This Worker is that something: one GET returns a ready-to-use `{ iceServers }` body
 * (Cloudflare's STUN + TURN endpoints with a fresh username/credential), which the
 * client feeds straight into `RTCPeerConnection` via trystero's `rtcConfig`.
 *
 * ── Cost guard ──
 * Cloudflare TURN is free up to 1 TB relayed/month (shared with SFU), then $0.05/GB,
 * and Cloudflare offers NO hard spending cap — only informational budget alerts. So the
 * cap is enforced here: before issuing TURN credentials, the Worker checks this month's
 * relayed egress via the GraphQL analytics API and, once it crosses TURN_MONTHLY_CAP_GB,
 * stops handing out TURN and returns STUN only. New sessions then can't relay (VPN-to-
 * non-VPN pairs degrade to STUN, same-network pairs still work); nothing new gets billed.
 * The check is cached 5 min (Cache API) so it doesn't query GraphQL on every request, and
 * fails OPEN on error/misconfig so a transient analytics hiccup never breaks collab.
 *
 * Secrets (set with `wrangler secret put`, never commit them):
 *   TURN_KEY_ID         — the TURN key's id
 *   TURN_KEY_API_TOKEN  — the TURN key's API token
 *   CF_ACCOUNT_ID       — account id, for the usage query (optional: unset = cap disabled)
 *   CF_ANALYTICS_TOKEN  — API token with Account Analytics:Read (optional: unset = disabled)
 * Vars (wrangler.jsonc):
 *   TURN_MONTHLY_CAP_GB — GB of TURN egress/month before falling back to STUN (default 900)
 */

export interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  TURN_MONTHLY_CAP_GB?: string;
}

/** Origins allowed to mint credentials. CORS is not real authz (any non-browser client
 * ignores it), but it keeps casual browser use of the endpoint scoped to Pochi's own
 * front-ends; the usage cap below is the real protection against runaway spend. */
const ALLOWED_ORIGINS = new Set([
  'https://sk0ya.github.io', // GitHub Pages (web build)
  'https://app.pochi', // desktop WebView2 virtual host (see desktop/MainWindow.xaml.cs)
]);

/** Credential lifetime. Cloudflare caps this at 48 h; a day comfortably outlives any
 * single editing session, and a reload just mints a fresh one. */
const TTL_SECONDS = 86400;

/** Default monthly TURN egress budget (GB) before the Worker stops issuing relay
 * credentials. 900, not 1000, leaves a safety margin under the free tier (which is also
 * shared with SFU). Override per-deploy via the TURN_MONTHLY_CAP_GB var. */
const DEFAULT_CAP_GB = 900;

/** How long a usage reading is trusted before re-querying GraphQL. Short enough that the
 * cap can't be overshot by much, long enough that credential issuance stays cheap/fast. */
const USAGE_CACHE_TTL_S = 300;

/** STUN-only body returned once the cap is hit — collab keeps working off-VPN, but no new
 * TURN allocations (and thus no new billable relay) are handed out. */
const STUN_ONLY = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] };

function allowedOrigin(origin: string | null): string {
  if (origin && (ALLOWED_ORIGINS.has(origin) || origin.startsWith('http://localhost'))) return origin;
  return 'https://sk0ya.github.io';
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(origin),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

function jsonResponse(body: string, cors: Record<string, string>): Response {
  return new Response(body, {
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** This month's TURN egress in GB, or null if the cap is disabled (analytics not
 * configured). Throws on a transient analytics failure so the caller can fail open. */
async function monthlyEgressGB(env: Env): Promise<number | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  const now = new Date();
  // Calendar-month (UTC) window. Cloudflare's billing period may differ slightly, but for
  // a safety cap month-start is close enough — and the margin under 1 TB absorbs the drift.
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const end = now.toISOString().slice(0, 10);
  const query = `query Usage($account: String!, $start: Date!, $end: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      callsTurnUsageAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 10000) {
        sum { egressBytes }
      }
    } }
  }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, start, end } }),
  });
  if (!res.ok) throw new Error(`analytics HTTP ${res.status}`);
  const data = (await res.json()) as {
    errors?: unknown[];
    data?: { viewer?: { accounts?: Array<{ callsTurnUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: number } }> }> } };
  };
  if (data.errors?.length) throw new Error(`analytics GraphQL error: ${JSON.stringify(data.errors)}`);
  const groups = data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups ?? [];
  const bytes = groups.reduce((n, g) => n + (g.sum?.egressBytes ?? 0), 0);
  return bytes / 1e9; // decimal GB, matching Cloudflare's GB billing unit
}

/** monthlyEgressGB wrapped in a 5-min Cache-API cache so we don't hit GraphQL per request. */
async function cachedEgressGB(env: Env, ctx: ExecutionContext): Promise<number | null> {
  const cacheKey = new Request('https://pochi-turn.internal/turn-usage-gb');
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return ((await hit.json()) as { gb: number }).gb;
  const gb = await monthlyEgressGB(env);
  if (gb !== null) {
    const cached = new Response(JSON.stringify({ gb }), {
      headers: { 'Cache-Control': `max-age=${USAGE_CACHE_TTL_S}`, 'Content-Type': 'application/json' },
    });
    ctx.waitUntil(cache.put(cacheKey, cached));
  }
  return gb;
}

/** True if this month's TURN usage is at/over the cap. Fails open (false) on any error so
 * a transient analytics outage degrades to "issue TURN" rather than breaking collab. */
async function overCap(env: Env, ctx: ExecutionContext): Promise<boolean> {
  try {
    const gb = await cachedEgressGB(env, ctx);
    if (gb === null) return false; // cap disabled
    const cap = Number(env.TURN_MONTHLY_CAP_GB) || DEFAULT_CAP_GB;
    return gb >= cap;
  } catch (err) {
    console.error('TURN usage cap check failed, issuing TURN anyway:', err);
    return false;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: cors });
    }
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return new Response('TURN key not configured', { status: 500, headers: cors });
    }

    // Cost guard: past the monthly cap, hand back STUN only so nothing new gets relayed.
    if (await overCap(env, ctx)) return jsonResponse(JSON.stringify(STUN_ONLY), cors);

    const cf = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );

    if (!cf.ok) {
      return new Response('failed to generate TURN credentials', { status: 502, headers: cors });
    }

    // Cloudflare's body is already `{ iceServers: [...] }` — exactly what the client wants,
    // so pass it through verbatim. no-store: credentials are per-request and short-lived.
    return new Response(cf.body, {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
