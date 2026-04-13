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
 * Sends the combined delivery + drink rating prompt.
 */
async function startFeedback(phone) {
  await sendMessage(
    phone,
    "🙌 Thanks for using NIBL\nAppreciate the order — hope you enjoyed it.\nTakes 2 seconds 👇\n⭐ Delivery: 1 2 3 4 5\n🥤 Drink: 1 2 3 4 5"
  );
  await setCustomerState(phone, 'awaiting_feedback');
}

/**
 * Customer replies with two space-separated ratings, e.g. "5 4".
 * state: awaiting_feedback
 */
async function handleFeedback(customer, body) {
  const phone = customer.phone;
  const parts = body.trim().split(/[\s,/]+/);
  const deliveryRating = parseInt(parts[0], 10);
  const drinkRating    = parseInt(parts[1], 10);

  if (
    isNaN(deliveryRating) || deliveryRating < 1 || deliveryRating > 5 ||
    isNaN(drinkRating)    || drinkRating < 1    || drinkRating > 5
  ) {
    await sendMessage(phone, "Please reply with two numbers e.g. 5 4\n⭐ Delivery first, 🥤 Drink second");
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (order) {
    await createFeedback(order.id, customer.id, deliveryRating, drinkRating);
    await logDrinkInteraction(order.id, customer.id);
  }

  const deliveryMsg = RATING_RESPONSES[deliveryRating] || "Thanks!";
  const drinkMsg    = RATING_RESPONSES[drinkRating]    || "Thanks!";
  await sendMessage(phone, `⭐ Delivery: ${deliveryMsg}\n🥤 Drink: ${drinkMsg}`);

  await sendMessage(phone, "Thanks for the feedback! See you next time 👋");
  await setCustomerState(phone, 'idle');
}

module.exports = { startFeedback, handleFeedback };
