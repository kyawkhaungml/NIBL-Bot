'use strict';

require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a single WhatsApp message via Twilio REST API.
 */
async function sendMessage(to, body) {
  const preview = body.length > 70 ? body.substring(0, 70) + '...' : body;
  console.log(`[${new Date().toISOString()}] → ${to}: ${preview}`);
  try {
    const msg = await client.messages.create({ from: FROM, to, body });
    return msg;
  } catch (err) {
    console.error(`[whatsapp] sendMessage failed to ${to}:`, err.message);
    throw err;
  }
}

/**
 * Send a WhatsApp message with an attached image.
 * mediaUrl must be publicly accessible (or a Twilio-hosted URL from the same account).
 */
async function sendMediaMessage(to, body, mediaUrl) {
  const preview = body.length > 70 ? body.substring(0, 70) + '...' : body;
  console.log(`[${new Date().toISOString()}] → ${to}: [media] ${preview}`);
  try {
    const msg = await client.messages.create({ from: FROM, to, body, mediaUrl: [mediaUrl] });
    return msg;
  } catch (err) {
    console.error(`[whatsapp] sendMediaMessage failed to ${to}:`, err.message);
    throw err;
  }
}

/**
 * Send multiple messages sequentially with a 2-second delay between each.
 */
async function sendMessages(to, messages) {
  for (let i = 0; i < messages.length; i++) {
    await sendMessage(to, messages[i]);
    if (i < messages.length - 1) {
      await delay(2000);
    }
  }
}

module.exports = { sendMessage, sendMediaMessage, sendMessages, delay };
