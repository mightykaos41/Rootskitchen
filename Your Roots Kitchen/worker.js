/**
 * Your Roots Kitchen — Cloudflare Worker backend
 *
 * Serves the app (index.html) and proxies AI calls so API keys stay
 * server-side as Worker secrets, never in the browser. Optionally
 * enforces a freemium paywall via Stripe.
 *
 * Endpoints:
 *   GET  /api/health     -> which features are configured
 *   POST /api/anthropic  -> recipe generation / file parsing (Claude)
 *   POST /api/images     -> recipe-card illustration (OpenAI images)
 *   POST /api/redeem     -> exchange a paid Stripe Checkout session for an unlimited pass
 *
 * Secrets (set with `npx wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY  — required for live recipes & file parsing
 *   OPENAI_API_KEY     — required for painted illustrations
 *   STRIPE_SECRET_KEY  — required for the paywall (sk_live_… or sk_test_…)
 *
 * Vars (wrangler.toml [vars]):
 *   STRIPE_PAYMENT_LINK — your Stripe Payment Link URL
 *   FREE_DISHES_PER_DAY — free dish generations per visitor per day (default 3)
 *   PASS_DAYS           — how long a purchased pass lasts (default 365)
 *
 * KV (required for the free-quota counter):
 *   QUOTA — create with `npx wrangler kv namespace create QUOTA`
 *
 * Anything missing degrades gracefully: no Stripe = no paywall;
 * no KV = quota not counted (paywall stays off); no AI keys = the
 * app's built-in recipe box and SVG art.
 */

const ALLOWED_ANTHROPIC_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const ALLOWED_IMAGE_MODELS = ["gpt-image-1", "dall-e-3"];
const MAX_TOKENS_CAP = 4000;

/* CORS is only needed when index.html is opened as a local file with
   WORKER_URL set. Tighten to your domain for production. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-yrk-dish, x-yrk-pass"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS }
  });
}

/* ---------- signed pass tokens (HMAC-SHA256) ---------- */
async function hmacKey(env) {
  const secret = env.PASS_SIGNING_SECRET || env.STRIPE_SECRET_KEY || "yrk-dev-secret";
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function makePass(env, days) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + days * 86400000 })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload)));
  return payload + "." + sig;
}

async function verifyPass(env, token) {
  try {
    if (!token) return false;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return false;
    const expected = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload)));
    if (expected !== sig) return false;
    const data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return data.exp > Date.now() ? data : false;
  } catch { return false; }
}

/* ---------- paywall helpers ---------- */
function paywallEnabled(env) {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_PAYMENT_LINK && env.QUOTA);
}

async function checkQuota(env, request) {
  /* returns {allowed, remaining} and increments on success */
  const limit = Number(env.FREE_DISHES_PER_DAY) || 3;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `q:${day}:${ip}`;
  const used = Number(await env.QUOTA.get(key)) || 0;
  if (used >= limit) return { allowed: false, remaining: 0 };
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 172800 });
  return { allowed: true, remaining: limit - used - 1 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        anthropic: !!env.ANTHROPIC_API_KEY,
        openai: !!env.OPENAI_API_KEY,
        paywall: paywallEnabled(env),
        freePerDay: Number(env.FREE_DISHES_PER_DAY) || 3,
        paymentLink: env.STRIPE_PAYMENT_LINK || ""
      });
    }

    /* ---- redeem a paid Stripe Checkout session for a pass ---- */
    if (url.pathname === "/api/redeem" && request.method === "POST") {
      if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments not configured" }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const id = String(body.session_id || "");
      if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return json({ error: "Invalid session id" }, 400);

      const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
      });
      if (!res.ok) return json({ error: "Could not verify payment" }, 402);
      const session = await res.json();
      if (session.payment_status !== "paid") return json({ error: "Payment not completed" }, 402);

      const days = Number(env.PASS_DAYS) || 365;
      const token = await makePass(env, days);
      return json({ pass: token, days });
    }

    if (url.pathname === "/api/anthropic" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "Anthropic not configured" }, 503);

      /* ---- meter dish generations (uploads/parsing are not metered) ---- */
      if (request.headers.get("x-yrk-dish") === "1" && paywallEnabled(env)) {
        const pass = await verifyPass(env, request.headers.get("x-yrk-pass"));
        if (!pass) {
          const quota = await checkQuota(env, request);
          if (!quota.allowed) {
            return json({
              error: "quota_exceeded",
              message: "Free dishes for today are used up.",
              paymentLink: env.STRIPE_PAYMENT_LINK,
              freePerDay: Number(env.FREE_DISHES_PER_DAY) || 3
            }, 402);
          }
        }
      }

      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      const payload = {
        model: ALLOWED_ANTHROPIC_MODELS.includes(body.model) ? body.model : ALLOWED_ANTHROPIC_MODELS[0],
        max_tokens: Math.min(Number(body.max_tokens) || 3000, MAX_TOKENS_CAP),
        system: typeof body.system === "string" ? body.system.slice(0, 2000) : "",
        messages: body.messages
      };
      if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        return json({ error: "messages required" }, 400);
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json", ...CORS }
      });
    }

    if (url.pathname === "/api/images" && request.method === "POST") {
      if (!env.OPENAI_API_KEY) return json({ error: "OpenAI not configured" }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return json({ error: "prompt required" }, 400);

      const payload = {
        model: ALLOWED_IMAGE_MODELS.includes(body.model) ? body.model : ALLOWED_IMAGE_MODELS[0],
        prompt: body.prompt.slice(0, 3900),
        size: body.size,
        n: 1
      };
      if (payload.model === "gpt-image-1") payload.quality = "medium";
      if (payload.model === "dall-e-3") payload.response_format = "b64_json";

      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json", ...CORS }
      });
    }

    /* everything else: serve the app's static assets (index.html) */
    return env.ASSETS.fetch(request);
  }
};
