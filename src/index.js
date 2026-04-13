'use strict';

require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const { getCustomerByPhone, upsertCustomer, ensureReferralCode } = require('./db');
const { sendMessage } = require('./whatsapp');
const { handleUnknown, handleInvited } = require('./flows/onboarding');
const { handleImage, handlePlatformReply, handleAddressReply, handleCustomerStatusQuery } = require('./flows/order');
const { handleFeedback } = require('./flows/feedback');
const { handleOperatorMessage } = require('./flows/operator');
const { isAdmin, ADMINS } = require('./admins');
const { handleDealReply } = require('./flows/reengagement');

// Start scheduler (registers cron jobs)
// TODO: re-enable when re-engagement messages are ready
// require('./scheduler');

const app = express();

// Twilio sends webhook bodies as application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// ─── Twilio signature validation middleware ──────────────────────────────────

function validateTwilioSignature(req, res, next) {
  // Skip validation in development when SKIP_TWILIO_VALIDATION=true
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
    return next();
  }

  const signature = req.headers['x-twilio-signature'] || '';
  const publicUrl = process.env.PUBLIC_URL;

  if (!publicUrl) {
    console.warn('[webhook] PUBLIC_URL not set — skipping signature validation');
    return next();
  }

  const url = publicUrl.replace(/\/$/, '') + req.path;
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    console.warn('[webhook] Invalid Twilio signature — rejected request from', req.ip);
    return res.status(403).send('Forbidden');
  }

  next();
}

// ─── Inbound message handler ─────────────────────────────────────────────────

async function handleInbound(body) {
  const from = body.From || '';
  const msgBody = (body.Body || '').trim();
  const mediaUrl = body.MediaUrl0 || null;
  const numMedia = parseInt(body.NumMedia || '0', 10);
  const upperBody = msgBody.toUpperCase();

  console.log(`[webhook] ← ${from}: "${msgBody}" (media: ${numMedia})`);

  // ── Operator short-circuit ─────────────────────────────────────────────────
  if (isAdmin(from)) {
    return handleOperatorMessage(from, msgBody);
  }

  // ── Forward every customer message to operator so they can monitor live ───
  const shortFrom = from.replace('whatsapp:', '');
  const forwardPreview = numMedia > 0
    ? `📸 [image] ${mediaUrl || ''}`
    : msgBody;
  ADMINS.forEach(admin => sendMessage(admin, `💬 ${shortFrom}:\n${forwardPreview}`).catch(() => {}));
  // (fire-and-forget — don't let forwarding failure block the main flow)

  // ── Load customer ──────────────────────────────────────────────────────────
  let customer = await getCustomerByPhone(from);

  // Touch last_active_at for existing customers
  if (customer) {
    await upsertCustomer(from, { last_active_at: new Date().toISOString() });
    // Re-fetch updated record
    customer = await getCustomerByPhone(from);
  }

  // ── Global commands (work at any state) ───────────────────────────────────
  if (upperBody === 'HELP') {
    await sendMessage(
      from,
      "Here's what you can do:\n📸 Send a screenshot — place a new order\nDEAL — see current promotions\nSTATUS — check your last order\nREFERRAL — get your referral link\n\nReply anytime and we'll get back to you!"
    );
    return;
  }

  if (upperBody === 'DEAL') {
    return handleDealReply(customer || { phone: from });
  }

  if (upperBody === 'STATUS') {
    return handleCustomerStatusQuery(customer);
  }

  if (upperBody === 'REFERRAL') {
    if (!customer || customer.status !== 'active') {
      await sendMessage(from, "You need to be an active member to get a referral link. Send a screenshot to place your first order!");
      return;
    }
    const code = await ensureReferralCode(customer.id);
    const baseUrl = process.env.BASE_URL || 'https://nibl.app';
    await sendMessage(
      from,
      code
        ? `Your referral link: ${baseUrl}/ref/${code} 🎁 Share it with friends — when they order, you both get a discount!`
        : "Couldn't generate your referral code right now. Try again later!"
    );
    return;
  }

  // ── Self-invite via JOIN-NIBL code ───────────────────────────────────────
  if (upperBody === 'JOIN-NIBL') {
    if (customer && customer.status === 'active') {
      await sendMessage(from, "You're already an active NIBL member! 🎉 Send a screenshot to place an order 📸");
      return;
    }
    await upsertCustomer(from, { status: 'invited' });
    const invitedCustomer = await getCustomerByPhone(from);
    return handleInvited(invitedCustomer);
  }

  // ── Unknown / waitlist ────────────────────────────────────────────────────
  if (!customer || customer.status === 'waitlist') {
    return handleUnknown(from, msgBody, customer);
  }

  // ── Invited — send welcome sequence ───────────────────────────────────────
  if (customer.status === 'invited') {
    return handleInvited(customer);
  }

  // ── Active customer — state machine ──────────────────────────────────────
  const state = customer.state || 'idle';

  // Image takes priority over text state
  if (numMedia > 0 && mediaUrl) {
    return handleImage(customer, mediaUrl);
  }

  switch (state) {
    case 'awaiting_platform':
      return handlePlatformReply(customer, msgBody);

    case 'awaiting_address':
      return handleAddressReply(customer, msgBody);

    case 'awaiting_feedback':
      return handleFeedback(customer, msgBody);

    default:
      // Idle active customer — silently ignore unrecognised text/extra screenshots
      break;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Main WhatsApp webhook
app.post('/webhook', validateTwilioSignature, (req, res) => {
  // Respond immediately with empty TwiML — replies are sent via REST API
  res.type('text/xml').send('<?xml version="1.0"?><Response/>');

  // Process asynchronously so we don't block Twilio's 15s timeout
  handleInbound(req.body).catch(err => {
    console.error('[webhook] Unhandled error in handleInbound:', err);
  });
});

// Twilio delivery status callback
app.post('/webhook/status', (req, res) => {
  const { MessageStatus, To, MessageSid } = req.body;
  console.log(`[status] ${MessageSid} → ${To}: ${MessageStatus}`);
  res.sendStatus(200);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`[nibl-bot] Listening on port ${PORT}`);
  console.log(`[nibl-bot] Operator number: ${process.env.OPERATOR_WHATSAPP}`);
  console.log(`[nibl-bot] Twilio number:   ${process.env.TWILIO_WHATSAPP_NUMBER}`);
});
