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
 * Customer sends an image (order screenshot).
 * Only accepted when state is awaiting_screenshot.
 */
async function handleImage(customer, mediaUrl) {
  const phone = customer.phone;

  if (customer.state !== 'awaiting_screenshot') {
    await sendMessage(phone, "We're not ready for your screenshot yet — we'll let you know when to send it! 😊");
    return;
  }

  const order = await createOrder(customer.id, mediaUrl);
  if (!order) {
    await sendMessage(phone, "Sorry, something went wrong saving your order. Please try again!");
    return;
  }

  await updateOrderStatus(order.id, 'screenshot_received');
  await updateOrderAddress(order.id, customer.address || '');
  await setCustomerState(phone, 'awaiting_screenshot_verification');
  await sendMessage(phone, "Got your order screenshot! 👀\nGive us a moment to review it.");

  const shortPhone = phone.replace('whatsapp:', '');
  const caption =
    `📸 SCREENSHOT RECEIVED\n` +
    `Customer: ${shortPhone}\n` +
    `Address: ${customer.address || 'N/A'}\n` +
    `Screenshot: ${order.screenshot_url}\n\n` +
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
    `BADAD ${shortPhone}`;
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
  await sendMessage(phone, `Your last order status:\n${statusText}`);
}

module.exports = {
  handleImage,
  handleAddressSubmission,
  handleCustomerStatusQuery,
};
