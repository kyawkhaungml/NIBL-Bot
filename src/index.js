'use strict';

require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const { getCustomerByPhone, upsertCustomer, ensureReferralCode, setCustomerState } = require('./db');
const { sendMessage } = require('./whatsapp');
const { handleInvited } = require('./flows/onboarding');
const { handleImage, handleAddressSubmission, handleCustomerStatusQuery } = require('./flows/order');
const { handleFeedback } = require('./flows/feedback');
const { handleOperatorMessage } = require('./flows/operator');
const { isAdmin, ADMINS } = require('./admins');
const { getClaimant } = require('./claims');
const { handleDealReply } = require('./flows/reengagement');

// Start scheduler (registers cron jobs)
require('./scheduler');

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
  const numMedia = parseInt(body.NumMedia || '0', 10);
  const upperBody = msgBody.toUpperCase();

  // Collect every media URL Twilio attached (MediaUrl0, MediaUrl1, …)
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    const u = body[`MediaUrl${i}`];
    if (u) mediaUrls.push(u);
  }

  console.log(`[webhook] ← ${from}: "${msgBody}" (media: ${numMedia})`);

  // ── Operator short-circuit ─────────────────────────────────────────────────
  if (isAdmin(from)) {
    return handleOperatorMessage(from, msgBody);
  }

  // ── Forward every customer message to operator(s) ─────────────────────────
  // If one admin has claimed this customer, only they receive the forward.
  // Otherwise broadcast to all admins (unclaimed conversation).
  const shortFrom = from.replace('whatsapp:', '');
  const claimant = getClaimant(from);
  const forwardTo = claimant ? [claimant] : ADMINS;

  let forwardMsg;
  if (mediaUrls.length > 0) {
    const imgLines = mediaUrls.map((u, i) =>
      mediaUrls.length === 1 ? `📸 Screenshot: ${u}` : `📸 Screenshot ${i + 1}: ${u}`
    ).join('\n');
    forwardMsg = `📨 [CUSTOMER: ${shortFrom}]\n${imgLines}`;
  } else if (numMedia > 0) {
    const mediaType = body.MediaContentType0 || 'media';
    forwardMsg = `📨 [CUSTOMER: ${shortFrom}]\n${mediaType} received`;
  } else {
    forwardMsg = `📨 [CUSTOMER: ${shortFrom}]\n${msgBody}`;
  }
  // fire-and-forget — forwarding failure must never block the customer flow
  forwardTo.forEach(admin =>
    sendMessage(admin, forwardMsg).catch(err => {
      console.error('[webhook] forward failed:', err.message);
    })
  );

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
      "Here's what you can do:\n📸 Send a screenshot — place a new order\nORDER — start a repeat order\nDEAL — see current promotions\nSTATUS — check your last order\nREFERRAL — get your referral link\n\nReply anytime and we'll get back to you!"
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

  if (upperBody === 'ORDER') {
    if (!customer || customer.status !== 'active') {
      await sendMessage(from, "Welcome to NIBL! 👋\nTo get started, reply with JOIN-NIBL");
      return;
    }
    const orderState = customer.state || 'idle';
    const repeatableStates = ['idle', 'awaiting_feedback', 'address_rejected'];
    if (repeatableStates.includes(orderState)) {
      await sendMessage(
        from,
        "Let's run another order! 🎉\nWhat's your delivery address? 📍\n(If it's the same as last time, just type it again)"
      );
      await setCustomerState(from, 'awaiting_address');
      const lastAddress = customer.address || 'N/A';
      ADMINS.forEach(admin =>
        sendMessage(
          admin,
          `🔄 REPEAT ORDER\nCustomer: ${shortFrom}\nLast address: ${lastAddress}\nNow asking for new address`
        ).catch(err => console.error('[webhook] repeat order forward failed:', err.message))
      );
    } else {
      await sendMessage(from, "You already have an order in progress!\nReply HELP to see your current status 🙌");
    }
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
  if (!customer || (customer.status !== 'active' && customer.status !== 'invited')) {
    await sendMessage(from, "Welcome to NIBL! 👋\nTo get started, reply with JOIN-NIBL");
    return;
  }

  // ── Invited — send welcome sequence ───────────────────────────────────────
  if (customer.status === 'invited') {
    return handleInvited(customer);
  }

  // ── Active customer — state machine ──────────────────────────────────────
  const state = customer.state || 'idle';

  // Image takes priority over text state
  if (mediaUrls.length > 0) {
    return handleImage(customer, mediaUrls);
  }

  switch (state) {
    case 'awaiting_address':
      return handleAddressSubmission(customer, msgBody);

    case 'awaiting_address_verification':
      await sendMessage(from, "We're still checking your address — we'll get back to you shortly! 🙏");
      return;

    case 'awaiting_screenshot':
      // Text received but no image
      await sendMessage(from, "We're ready for your screenshot! Just send it over 📸");
      return;

    case 'awaiting_screenshot_verification':
    case 'awaiting_confirmation':
      await sendMessage(from, "Your screenshot is under review — almost there! 👀");
      return;

    case 'order_confirmed':
    case 'order_on_the_way':
      return; // silently ignore during active delivery

    case 'address_rejected':
      await sendMessage(from, "We'll let you know when we expand to your area! Stay tuned 👀");
      return;

    case 'awaiting_feedback':
      return handleFeedback(customer, msgBody);

    default:
      // idle or unrecognized — silently ignore
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
  console.log(`[nibl-bot] Twilio number:   ${process.env.TWILIO_WHATSAPP_NUMBER}`);
  console.log(`[nibl-bot] Admins (${ADMINS.length}): ${ADMINS.join(', ')}`);
});
