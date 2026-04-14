# NIBL Bot

WhatsApp concierge delivery bot. Customers text order screenshots and receive free delivery + a surprise drink. Built with Node.js, Twilio, and Supabase.

---

## Stack

- **Runtime**: Node.js 18
- **Framework**: Express.js
- **WhatsApp**: Twilio Programmable Messaging (WhatsApp Sandbox)
- **Database**: Supabase (Postgres)
- **Scheduler**: node-cron
- **Deploy**: Railway

---

## 1. Twilio WhatsApp Sandbox Setup

1. Log in to [console.twilio.com](https://console.twilio.com)
2. Go to **Messaging → Try it out → Send a WhatsApp message**
3. Note the **sandbox number** (e.g. `+1 415 523 8886`) and **join code** (e.g. `join apple-mango`)
4. From your phone, WhatsApp the sandbox number with the join code to activate your test session
5. Go to **Messaging → Settings → WhatsApp Sandbox Settings**
6. Set **When a message comes in** to:
   ```
   https://YOUR_PUBLIC_URL/webhook
   ```
7. Set **Status callback URL** to:
   ```
   https://YOUR_PUBLIC_URL/webhook/status
   ```
8. Save. Your PUBLIC_URL comes from ngrok (local) or Railway (production).

---

## 2. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key → `SUPABASE_SERVICE_KEY`
3. Go to **SQL Editor** and paste the contents of `supabase/migrations/001_init.sql`
4. Click **Run** — all 5 tables are created

---

## 3. Local Development with ngrok

```bash
# Clone and install
cd whatsapp-bot
npm install

# Copy env file and fill in your credentials
cp .env.example .env

# Start ngrok to get a public URL
ngrok http 3000

# Copy the https URL from ngrok output e.g. https://abc123.ngrok.io
# Set in .env:  PUBLIC_URL=https://abc123.ngrok.io

# Start the bot
npm run dev
```

Update Twilio sandbox webhook URL to `https://abc123.ngrok.io/webhook` each time ngrok restarts (free tier generates a new URL each session).

Test the health endpoint:
```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

**Local dev tip**: Set `SKIP_TWILIO_VALIDATION=true` in `.env` to bypass signature checks when testing with tools like Postman or curl.

---

## 4. Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select your repo
4. Go to **Variables** and add all keys from `.env.example`
   - Set `PUBLIC_URL` to your Railway-assigned URL (found in **Settings → Domains**)
5. Railway auto-deploys on every push. Logs are in the **Deploy** tab.
6. Update Twilio webhook URL to your Railway URL

---

## 5. Inviting the First Customer

From your `OPERATOR_WHATSAPP` number, text the bot:

```
INVITE whatsapp:+12125551234
```

The bot will immediately send that number the 3-part welcome sequence and mark them as active.

---

## 6. Operator Commands Reference

All commands are sent **from your operator WhatsApp number** to the bot number.

| Command | Description | Example |
|---------|-------------|---------|
| `CHECKAD <phone>` | Approve delivery address — unlocks screenshot submission | `CHECKAD +12125551234` |
| `VALIDAD <phone>` | Ask customer to resend a valid/complete address | `VALIDAD +12125551234` |
| `BADAD <phone>` | Reject area — 24h lockout, then auto-reset to awaiting_address | `BADAD +12125551234` |
| `SSCHECKED <phone>` | Approve screenshot — notify customer, move to confirmation | `SSCHECKED +12125551234` |
| `BADSS <phone>` | Unclear screenshot — ask customer to resend | `BADSS +12125551234` |
| `CONFIRM <phone> <mins> <driver>` | Send ETA + driver name to customer | `CONFIRM +12125551234 25 John` |
| `OTW <phone>` | Mark order on the way, notify customer | `OTW +12125551234` |
| `DONE <phone>` | Mark delivered + send feedback prompt | `DONE +12125551234` |
| `REJECT-FAR <phone>` | Reject order — drop-off out of range | `REJECT-FAR +12125551234` |
| `REJECT-FULL <phone>` | Reject order — delivery window full | `REJECT-FULL +12125551234` |
| `STATUS <phone> <status>` | Manual order status override | `STATUS +12125551234 on_the_way` |
| `MSG <phone> <text>` | Send a custom message to a customer | `MSG +12125551234 Running 10 min late!` |
| `BROADCAST <message>` | Send a message to all active customers | `BROADCAST New drinks this week! 🥤` |
| `INVITE <phone>` | Invite a number — sends welcome sequence | `INVITE +12125551234` |
| `WAITLIST` | List all waitlisted customers | `WAITLIST` |
| `STATS` | Show active count, orders today/week, avg rating | `STATS` |

**Valid order statuses for STATUS command:**

| Status | Customer sees |
|--------|---------------|
| `received` | Nothing (internal update) |
| `picking_up` | Nothing (internal update) |
| `on_the_way` | "Your order is on the way! 🛵 Should be there in ~20 min..." |
| `delivered` | "Delivered! 🎉" + feedback prompt (1–5 stars) |

---

## 7. Customer Commands

Customers can text these at any time:

| Command | Action |
|---------|--------|
| *(send an image)* | Start a new order |
| `ORDER` | Start a repeat order |
| `HELP` | Show help menu |
| `STATUS` | Check latest order status |
| `DEAL` | See current promotion (set via `CURRENT_DEAL` env var) |
| `REFERRAL` | Get personal referral link |

---

## 8. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_WHATSAPP_NUMBER` | Yes | Twilio sandbox number e.g. `whatsapp:+14155238886` |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `OPERATOR_WHATSAPP` | Yes | Your WhatsApp number e.g. `whatsapp:+12125551234` |
| `PORT` | No | Server port (default: 3000) |
| `PUBLIC_URL` | Yes | Public URL for Twilio signature validation |
| `BASE_URL` | No | Base URL for referral links (default: https://nibl.app) |
| `CURRENT_DEAL` | No | Deal text shown when customer texts DEAL |
| `SKIP_TWILIO_VALIDATION` | No | Set `true` to disable sig validation (local dev only) |

---

## Re-engagement Schedule

The bot automatically runs a re-engagement job daily at **6pm (server timezone)**:

- **7+ days since last order** → "Hey [name]! 👋 It's been a week..."
- **14+ days since last order** → "Miss us? 😄 We're running a deal..."

`last_active_at` is updated every time a customer sends any message.
