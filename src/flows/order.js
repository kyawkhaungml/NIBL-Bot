'use strict';

const {
  createOrder,
  getLatestOrder,
  updateOrderStatus,
  updateOrderAddress,
  upsertCustomer,
  setCustomerState,
} = require('../db');
const { sendMessage } = require('../whatsapp');
const { ADMINS } = require('../admins');
const { getClaimant } = require('../claims');

const STATUS_MESSAGES = {
  screenshot_received:     '📥 We received your screenshot and are reviewing it!',
  screenshot_verified:     '✅ Screenshot verified — confirming your order now.',
  screenshot_rejected:     '❌ Screenshot unclear — we asked you to resend.',
  confirmed:               '🙌 Order confirmed — on our way to pick it up!',
  on_the_way:              '🛵 On the way to you!',
  delivered:               '✅ Delivered!',
};

/**
 * Customer sends one or more images (order screenshots).
 * Only accepted when state is awaiting_screenshot.
 * mediaUrls is an array; the first URL is stored on the order record.
 */
async function handleImage(customer, mediaUrls) {
  const phone = customer.phone;

  if (customer.state !== 'awaiting_screenshot') {
    await sendMessage(phone, "We're not ready for your screenshot yet — we'll let you know when to send it! 😊");
    return;
  }

  const primaryUrl = mediaUrls[0];
  const order = await createOrder(customer.id, primaryUrl);
  if (!order) {
    await sendMessage(phone, "Sorry, something went wrong saving your order. Please try again!");
    return;
  }

  await updateOrderStatus(order.id, 'screenshot_received');
  await updateOrderAddress(order.id, customer.address || '');
  await setCustomerState(phone, 'awaiting_screenshot_verification');
  await sendMessage(phone, "Got your order screenshot! 👀\nGive us a moment to review it.");

  const shortPhone = phone.replace('whatsapp:', '');
  const screenshotLines = mediaUrls.length === 1
    ? `Screenshot: ${primaryUrl}`
    : mediaUrls.map((u, i) => `Screenshot ${i + 1}: ${u}`).join('\n');

  const caption =
    `📸 SCREENSHOT RECEIVED\n` +
    `Customer: ${shortPhone}\n` +
    `Address: ${customer.address || 'N/A'}\n` +
    `${screenshotLines}\n\n` +
    `SSCHECKED ${shortPhone}\n` +
    `BADSS ${shortPhone}`;

  const claimant = getClaimant(phone);
  const recipients = claimant ? [claimant] : ADMINS;
  await Promise.all(recipients.map(admin => sendMessage(admin, caption)));
}

/**
 * Customer replies with their delivery address.
 * state: awaiting_address
 */
async function handleAddressSubmission(customer, body) {
  const phone = customer.phone;
  const address = body.trim();

  await upsertCustomer(phone, { address });
  await setCustomerState(phone, 'awaiting_address_verification');
  await sendMessage(phone, "Got it! 📍 We're checking if we deliver to your area — sit tight, we'll confirm shortly.");

  const shortPhone = phone.replace('whatsapp:', '');
  const adminMsg =
    `📍 ADDRESS CHECK\n` +
    `Customer: ${shortPhone}\n` +
    `Address: ${address}\n\n` +
    `CHECKAD ${shortPhone}\n` +
    `BADAD ${shortPhone}`+
    `VALIDAD ${shortPhone}`;
  await Promise.all(ADMINS.map(admin => sendMessage(admin, adminMsg)));
}

/**
 * Customer texts STATUS — show their latest order status.
 */
async function handleCustomerStatusQuery(customer) {
  const phone = customer.phone;

  if (!customer) {
    await sendMessage(phone, "You haven't placed an order yet! Send a screenshot to get started 📸");
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(phone, "You haven't placed an order yet! Send a screenshot to get started 📸");
    return;
  }

  const statusText = STATUS_MESSAGES[order.status] || '❓ Unknown status';
  const repeatPrompt = order.status === 'delivered' ? '\n\nWant to order again? Reply ORDER 🛵' : '';
  await sendMessage(phone, `Your last order status:\n${statusText}${repeatPrompt}`);
}

module.exports = {
  handleImage,
  handleAddressSubmission,
  handleCustomerStatusQuery,
};
