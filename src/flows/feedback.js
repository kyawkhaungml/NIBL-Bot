'use strict';

const {
  getLatestOrder,
  createFeedback,
  logDrinkInteraction,
  setCustomerState,
} = require('../db');
const { sendMessage } = require('../whatsapp');

const RATING_RESPONSES = {
  5: "So glad you loved it! 🙌",
  4: "Awesome, glad it went well!",
  3: "Thanks for the feedback, we'll keep improving!",
  2: "Sorry to hear that 😔 We want to make it right.",
  1: "Sorry to hear that 😔 We want to make it right.",
};

/**
 * Called by operator flow when an order is marked as delivered.
 * Sends thank you immediately, then schedules the drink rating prompt for 30 min later.
 */
async function startFeedback(phone) {
  await sendMessage(
    phone,
    "🙌 Thanks for using NIBL!\nHope you enjoyed the order — see you next time 👋"
  );
  await setCustomerState(phone, 'idle');

  setTimeout(async () => {
    try {
      await sendMessage(
        phone,
        "🥤 How was the drink we included with your order?\nRate it 1–5:"
      );
      await setCustomerState(phone, 'awaiting_feedback');
      await sendMessage(phone, "Want to order again? Reply ORDER anytime 🛵");
    } catch (err) {
      console.error('[feedback] delayed drink prompt failed for', phone, ':', err.message);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

/**
 * Customer replies with a single drink rating, e.g. "4".
 * state: awaiting_feedback
 */
async function handleFeedback(customer, body) {
  const phone = customer.phone;
  const drinkRating = parseInt(body.trim(), 10);

  if (isNaN(drinkRating) || drinkRating < 1 || drinkRating > 5) {
    await sendMessage(phone, "Could you please rate the drink from your previous order before you start the new order?\nPlease reply with a number 1–5 🥤");
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (order) {
    await createFeedback(order.id, customer.id, drinkRating, drinkRating);
    await logDrinkInteraction(order.id, customer.id);
  }

  const drinkMsg = RATING_RESPONSES[drinkRating] || "Thanks!";
  await sendMessage(phone, `🥤 Drink: ${drinkMsg}\nThanks for the feedback! See you next time 👋`);
  await setCustomerState(phone, 'idle');
}

module.exports = { startFeedback, handleFeedback };
