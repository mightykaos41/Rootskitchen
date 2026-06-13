#!/bin/bash
# Your Roots Kitchen — one-time guided setup
# Run from this folder:  bash setup.sh
set -e
cd "$(dirname "$0")"

bold(){ printf "\n\033[1m%s\033[0m\n" "$1"; }

bold "🍲 Your Roots Kitchen setup"
echo "This walks you through deploying the app. You can skip any optional step"
echo "by pressing Enter — that feature just stays off until you add it later."

# 0. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required. Install it from https://nodejs.org and re-run."
  exit 1
fi

# 1. Cloudflare login
bold "Step 1/6 — Cloudflare login (browser window will open)"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# Initial deploy so the Worker exists and is current — secrets can only be
# attached to a deployed version (avoids the "Secret edit failed" error).
bold "Publishing the app so keys can be attached…"
npx wrangler deploy

# 2. Anthropic key (recipes)
bold "Step 2/6 — Anthropic API key (unique recipes + reading uploads)"
echo "Get one at: https://console.anthropic.com → API Keys. Press Enter to skip."
read -r -s -p "Paste Anthropic key (hidden): " K; echo
if [ -n "$K" ]; then printf "%s" "$K" | npx wrangler secret put ANTHROPIC_API_KEY; echo "✓ saved"; else echo "– skipped"; fi

# 3. OpenAI key (images)
bold "Step 3/6 — OpenAI API key (painted recipe-card illustrations)"
echo "Get one at: https://platform.openai.com → API Keys. Press Enter to skip."
read -r -s -p "Paste OpenAI key (hidden): " K; echo
if [ -n "$K" ]; then printf "%s" "$K" | npx wrangler secret put OPENAI_API_KEY; echo "✓ saved"; else echo "– skipped"; fi

# 4. Storage (email list + free-quota counter)
bold "Step 4/6 — Storage (cookbook email list + free-dish counter)"
if grep -q '^\[\[kv_namespaces\]\]' wrangler.toml; then
  echo "✓ storage already configured"
else
  echo "Creating storage (KV namespace)…"
  OUT=$(npx wrangler kv namespace create QUOTA 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -o 'id = "[^"]*"' | head -1 | cut -d'"' -f2)
  if [ -n "$ID" ]; then
    printf '\n[[kv_namespaces]]\nbinding = "QUOTA"\nid = "%s"\n' "$ID" >> wrangler.toml
    echo "✓ storage created and wired into wrangler.toml"
  else
    echo "⚠ Couldn't parse the KV id automatically. Output was:"; echo "$OUT"
    echo "Add it to wrangler.toml manually (see README-deploy.md)."
  fi
fi

# 5. Stripe (monetization)
bold "Step 5/6 — Stripe (paywall: 3 free dishes/day, then unlimited pass)"
echo "Get your secret key at: https://dashboard.stripe.com → Developers → API keys."
echo "Press Enter to skip monetization for now."
read -r -s -p "Paste Stripe secret key (hidden): " K; echo
if [ -n "$K" ]; then
  printf "%s" "$K" | npx wrangler secret put STRIPE_SECRET_KEY; echo "✓ saved"
  echo
  echo "Paste your Stripe Payment Link URL (create one at dashboard.stripe.com → Payment Links;"
  echo "set its after-payment redirect to your app URL + /?session_id={CHECKOUT_SESSION_ID})."
  echo "Press Enter to add it later."
  read -r -p "Payment Link URL: " PL
  if [ -n "$PL" ]; then
    sed -i.bak "s|^STRIPE_PAYMENT_LINK = .*|STRIPE_PAYMENT_LINK = \"$PL\"|" wrangler.toml && rm -f wrangler.toml.bak
    echo "✓ payment link saved to wrangler.toml"
  fi
else
  echo "– skipped (app stays free)"
fi

# 6. Deploy
bold "Step 6/6 — Deploy"
npx wrangler deploy

bold "✅ Done!"
echo "Your app URL is printed above (https://your-roots-kitchen.<subdomain>.workers.dev)."
echo "If you set up Stripe, remember the Payment Link redirect must point at that URL."
echo "Export your email list anytime with:"
echo "  npx wrangler kv key list --binding QUOTA --remote --prefix email:"
echo "Re-run this script anytime to add or rotate keys, then it redeploys."
