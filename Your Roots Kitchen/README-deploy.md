# Your Roots Kitchen — Deploy Guide

The app runs entirely on **your** API keys. Users never see a key or a settings panel — they just get unique dishes and painted recipe cards. Keys are stored as Cloudflare Worker secrets, server-side only.

## One-time setup (~5 minutes)

You need a free Cloudflare account (cloudflare.com) and Node.js installed.

From this folder, run:

```bash
# 1. Log in to Cloudflare (opens a browser window)
npx wrangler login

# 2. Store your keys as encrypted secrets (paste when prompted)
npx wrangler secret put ANTHROPIC_API_KEY     # for unique recipes + reading uploads
npx wrangler secret put OPENAI_API_KEY        # for painted recipe-card illustrations

# 3. Deploy
npx wrangler deploy
```

That's it. Wrangler prints your live URL, something like:

```
https://your-roots-kitchen.<your-subdomain>.workers.dev
```

Open that URL — the app is live with AI fully wired. Share the link freely; your keys never leave Cloudflare.

Either secret is optional. Skip `OPENAI_API_KEY` and dishes use the built-in vintage card art; skip `ANTHROPIC_API_KEY` and dishes come from the built-in recipe box.

## Updating the app

Edit `index.html`, then run `npx wrangler deploy` again. Deploys take seconds.

## Testing locally

```bash
npx wrangler dev
```

Serves the app at `http://localhost:8787` using your real secrets (after step 2; for local-only secrets create a `.dev.vars` file with `ANTHROPIC_API_KEY=...`).

Note: opening `index.html` directly as a file works too, but runs in offline mode (recipe box + SVG art) — unless you paste your worker URL into the `WORKER_URL` constant near the top of the app's script.

## Monetization (optional): Stripe paywall

When configured, visitors get **3 free AI dishes per day** (the built-in recipe box stays free and unlimited). After that, a warm in-app screen offers an unlimited pass via Stripe Checkout. Until you configure Stripe, everything stays free — nothing breaks.

Setup (~10 minutes):

```bash
# 1. Create the quota counter (copy the printed id into wrangler.toml,
#    uncomment the [[kv_namespaces]] block)
npx wrangler kv namespace create QUOTA

# 2. Store your Stripe secret key (Stripe dashboard → Developers → API keys)
npx wrangler secret put STRIPE_SECRET_KEY
```

3. In the Stripe dashboard, create a **Payment Link** for your product (e.g. "Your Roots Kitchen — Unlimited Pass, $9/year"). Under the link's confirmation settings, redirect customers to your app URL with the session id:

```
https://your-roots-kitchen.<your-subdomain>.workers.dev/?session_id={CHECKOUT_SESSION_ID}
```

4. Paste the Payment Link URL into `STRIPE_PAYMENT_LINK` in `wrangler.toml`, then `npx wrangler deploy`.

How it works: the worker counts dish generations per visitor per day in KV. Over the limit it returns 402; the app shows the unlock screen. After checkout, Stripe redirects back, the app exchanges the session id at `/api/redeem`, the worker verifies the payment with Stripe and issues a signed pass (HMAC, expires after `PASS_DAYS`). The pass is stored in the visitor's browser and sent with future generations. Test end-to-end with a Stripe **test-mode** key and payment link first — test cards like 4242 4242 4242 4242 work.

Tuning: `FREE_DISHES_PER_DAY` and `PASS_DAYS` in `wrangler.toml`. For subscriptions instead of one-time passes, set `PASS_DAYS = "32"` on a monthly Payment Link — lapsed subscribers simply stop getting new passes. (True subscription-status checks via Stripe webhooks are a natural next step, not built yet.)

## Email list

Cookbook signups are stored in your Cloudflare KV namespace (the same `QUOTA` one), deduplicated by address. This requires the KV namespace to exist — `setup.sh` creates it automatically, or run `npx wrangler kv namespace create QUOTA` and add the printed id to `wrangler.toml`.

Export the list anytime:

```bash
npx wrangler kv key list --binding QUOTA --remote --prefix email:
```

Each key is `email:<address>`; the stored value holds the signup date. When you're ready for a real mailing tool (Mailchimp, Buttondown, etc.), export and import this list. Since you're storing personal data: only email them what they signed up for (cookbook updates), and delete an address on request with `npx wrangler kv key delete --binding QUOTA --remote "email:<address>"`.

## Costs & limits

- Cloudflare Workers free tier: 100,000 requests/day — far more than this MVP needs.
- Anthropic: roughly $0.01–0.03 per generated dish (claude-sonnet-4-6).
- OpenAI images: roughly $0.04–0.07 per illustration (gpt-image-1, medium quality).

## Before a public launch

The `/api` endpoints are open — anyone who finds the URL could call them and spend your credits. Fine for beta testing with friends; before promoting it widely you should:

1. Lock CORS to your domain (edit `CORS` in `worker.js`).
2. Add rate limiting (Cloudflare's free WAF rules, or a per-IP counter via KV).
3. Optionally set a daily spend cap in your Anthropic/OpenAI dashboards (do this regardless).
