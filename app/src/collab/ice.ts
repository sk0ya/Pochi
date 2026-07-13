/**
 * Supplies WebRTC ICE servers (STUN + Cloudflare TURN) for the collab mesh.
 *
 * Pochi has no backend of its own, so short-lived Cloudflare TURN credentials are
 * minted by a tiny Cloudflare Worker (see ../../../turn-worker/) that holds the TURN
 * key secret. This module calls that Worker and hands the result to trystero's
 * `rtcConfig.iceServers` (see session.ts). TURN is what lets two peers behind a
 * commercial VPN (symmetric NAT, no inbound) still connect: without it they have only
 * STUN, hole punching fails, and the data channel never opens — the exact "works
 * without VPN, dead with VPN" symptom.
 *
 * The fetch is best-effort: on any failure (Worker unset/unreachable, non-200, bad
 * JSON, timeout) we fall back to STUN only, so same-network / VPN-less collaboration
 * keeps working exactly as it did before TURN existed.
 */

/** The Worker that mints Cloudflare TURN credentials. Deploy turn-worker/ and paste
 * its URL here (see turn-worker/README.md). Empty string disables TURN (STUN only). */
const TURN_ENDPOINT = 'https://pochi-turn.shigekazukoya.workers.dev';

/** Public STUN fallback, used when the Worker is unset or unreachable. Enough to
 * connect peers on ordinary NATs; does NOT get across a commercial VPN (needs TURN). */
const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Give up on the Worker quickly — a slow/broken credential endpoint must not stall
 * joining a room; we just proceed with STUN and log the miss. */
const FETCH_TIMEOUT_MS = 4000;

/** Fetch STUN+TURN ICE servers for a new room. Never rejects: returns the STUN
 * fallback on any error so `joinCollab` can always proceed. */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  if (!TURN_ENDPOINT) return STUN_FALLBACK;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(TURN_ENDPOINT, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return STUN_FALLBACK;
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : STUN_FALLBACK;
  } catch {
    return STUN_FALLBACK;
  }
}
