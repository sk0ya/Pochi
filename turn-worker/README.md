# Pochi TURN worker

A tiny Cloudflare Worker that hands the Pochi web/desktop app a fresh set of WebRTC
`iceServers` (Cloudflare STUN + TURN) so P2P collaboration works **across a VPN**.

Without TURN, two peers where one is on a commercial VPN can't connect: the VPN's
symmetric NAT defeats STUN hole punching and there's no relay to fall back to. TURN is
that relay. Cloudflare only issues *short-lived* TURN credentials, which must be minted
server-side by something holding the TURN key secret — that's this Worker.

## One-time setup

1. **Create a TURN key** — Cloudflare dashboard → **Realtime** → **TURN** → *Create*.
   Copy the **Turn Token ID** and **API Token**.

2. **Install deps & log in**
   ```sh
   cd turn-worker
   npm install
   npx wrangler login
   ```

3. **Store the secrets** (never commit these)
   ```sh
   npx wrangler secret put TURN_KEY_ID          # paste the Turn Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN   # paste the API Token
   ```

4. **Deploy**
   ```sh
   npm run deploy
   ```
   Wrangler prints the URL, e.g. `https://pochi-turn.<your-subdomain>.workers.dev`.

5. **Point the app at it** — put that URL in `app/src/collab/ice.ts`:
   ```ts
   const TURN_ENDPOINT = 'https://pochi-turn.<your-subdomain>.workers.dev';
   ```
   Then rebuild/redeploy the app. (Empty string = TURN disabled, STUN only.)

## Monthly usage cap (stay under the free 1 TB)

Cloudflare TURN is free to 1 TB/month (shared with SFU) but has **no hard spending cap** —
only budget alerts, which don't stop anything. So the Worker enforces the cap itself:
before issuing TURN credentials it checks this month's relayed egress and, once it crosses
`TURN_MONTHLY_CAP_GB` (default **900 GB**, see `wrangler.jsonc`), returns **STUN only**. New
sessions then can't relay — off-VPN collab still works, VPN-crossing pairs degrade — and
nothing new gets billed. The reading is cached 5 min and **fails open**: if the usage check
errors or isn't configured, TURN is issued as normal (a transient outage won't break collab).

To turn the cap on, give the Worker read access to your usage analytics:

1. **Create an analytics API token** — Cloudflare dashboard → **My Profile** → **API Tokens**
   → *Create Token* → *Custom* → permission **Account · Account Analytics · Read**. Copy it.

2. **Find your Account ID** — dashboard → **Realtime** (or any account page); it's in the URL
   / the account's *Overview* sidebar.

3. **Store both as secrets**
   ```sh
   npx wrangler secret put CF_ACCOUNT_ID        # paste the Account ID
   npx wrangler secret put CF_ANALYTICS_TOKEN   # paste the analytics token
   npm run deploy
   ```

Adjust the budget by editing `TURN_MONTHLY_CAP_GB` in `wrangler.jsonc` (lower = more margin)
and redeploying. Leaving `CF_ACCOUNT_ID`/`CF_ANALYTICS_TOKEN` unset disables the cap.

It's still worth setting a Cloudflare **budget alert** (dashboard → Billing → Budget alerts)
as a backstop email notification — belt and suspenders on top of the Worker's hard cutoff.

## Verify

```sh
curl -H "Origin: https://sk0ya.github.io" https://pochi-turn.<your-subdomain>.workers.dev
```
Expect a JSON body with an `iceServers` array containing `turn:`/`turns:` URLs plus a
`username` and `credential`. Then open the app on two machines (one on the VPN) and join
the same room — they should now connect.

## Notes

- **CORS allowlist** lives in `src/index.ts` (`ALLOWED_ORIGINS`): the GitHub Pages origin,
  the desktop WebView2 host `https://app.pochi`, and `localhost` for dev. Add origins there
  if you host the app elsewhere.
- **Cost**: Cloudflare TURN is free up to 1 TB relayed/month, then $0.05/GB. Pochi relays
  only shape/cursor diffs (no media), so real usage stays deep inside the free tier.
- **Credential lifetime** is set by `TTL_SECONDS` in `src/index.ts` (max 48 h per Cloudflare).
