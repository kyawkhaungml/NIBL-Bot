'use strict';

const { sendMessage } = require('../whatsapp');

/**
 * Re-engagement nudge for customers with no order in the last 7 days.
 */
async function send7DayNudge(customer) {
  const name = customer.name || 'there';
  try {
    await sendMessage(
      customer.phone,
      `Hey ${name}! 👋 It's been a week — ready for another free delivery? We've got something new in the bag this week 👀 Just type ORDER!`
    );
  } catch (err) {
    console.error(`[reengagement] 7-day nudge failed for ${customer.phone}:`, err.message);
  }
}

/**
 * Re-engagement nudge for customers with no order in the last 14 days.
 */
async function send14DayNudge(customer) {
  try {
    await sendMessage(
      customer.phone,
      "Miss us? 😄 We're running a deal this week — text DEAL to see what's on."
    );
  } catch (err) {
    console.error(`[reengagement] 14-day nudge failed for ${customer.phone}:`, err.message);
  }
}

/**
 * Customer texts DEAL — send current deal from env.
 */
async function handleDealReply(customer) {
  const phone = customer.phone;
  const deal = process.env.CURRENT_DEAL;

  if (!deal) {
    await sendMessage(phone, "No active deal right now, but stay tuned! 🎁 Send a screenshot anytime to place an order.");
    return;
  }

  await sendMessage(phone, deal);
}

module.exports = { send7DayNudge, send14DayNudge, handleDealReply };
