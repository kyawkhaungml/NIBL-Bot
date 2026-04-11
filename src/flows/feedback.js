'use strict';

const {
  getLatestOrder,
  createFeedback,
  logDrinkInteraction,
  setCustomerState,
  ensureReferralCode,
} = require('../db');
const { sendMessage } = require('../whatsapp');

const RATING_RESPONSES = {
  5: "So glad you loved it! 🙌",
  4: "Awesome, glad it went well!",
  3: "Thanks for the feedback, we'll keep improving!",
  2: "Sorry to hear that 😔 What went wrong? We want to make it right.",
  1: "Sorry to hear that 😔 What went wrong? We want to make it right.",
};

/**
 * Called by operator flow when an order is marked as delivered.
 * Sends the delivery confirmation and prompts for rating.
 */
async function startFeedback(phone) {
  await sendMessage(
    phone,
    "Delivered! 🎉 Hope you love the surprise drink. How was your experience? Reply with ⭐ 1-5"
  );
  await setCustomerState(phone, 'awaiting_feedback_rating');
}

/**
 * Customer replies with a 1–5 rating.
 * state: awaiting_feedback_rating
 */
async function handleRating(customer, body) {
  const phone = customer.phone;
  const rating = parseInt(body.trim(), 10);

  if (isNaN(rating) || rating < 1 || rating > 5) {
    await sendMessage(phone, "Please reply with a number 1 to 5 ⭐");
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (order) {
    await createFeedback(order.id, customer.id, rating);
  }

  const ratingMsg = RATING_RESPONSES[rating] || "Thanks for the feedback!";
  await sendMessage(phone, `Thanks! ${ratingMsg}`);
  await sendMessage(phone, "One more thing — did you try the drink we included? Reply YES or NO 🥤");
  await setCustomerState(phone, 'awaiting_feedback_drink');
}

/**
 * Customer replies YES or NO about the drink.
 * state: awaiting_feedback_drink
 */
async function handleDrinkResponse(customer, body) {
  const phone = customer.phone;
  const answer = body.trim().toUpperCase();

  if (answer === 'YES') {
    const order = await getLatestOrder(customer.id);
    if (order) {
      await logDrinkInteraction(order.id, customer.id);
    }
  }

  const referralCode = await ensureReferralCode(customer.id);
  const baseUrl = process.env.BASE_URL || 'https://nibl.app';

  if (referralCode) {
    await sendMessage(
      phone,
      `Want free delivery on your next order? Share your referral link: ${baseUrl}/ref/${referralCode} — when a friend orders, you both get a discount 🎁`
    );
  } else {
    await sendMessage(phone, "Thanks for the feedback! See you next time 👋");
  }

  await setCustomerState(phone, 'idle');
}

module.exports = { startFeedback, handleRating, handleDrinkResponse };
