'use strict';

const {
  createOrder,
  getLatestOrder,
  updateOrderPlatform,
  updateOrderAddress,
  setCustomerState,
} = require('../db');
const { sendMessage } = require('../whatsapp');
const { ADMINS } = require('../admins');
const { getClaimant } = require('../claims');

const PLATFORM_MAP = {
  '1': 'doordash',
  '2': 'ubereats',
  '3': 'other',
};

const PLATFORM_LABELS = {
  doordash: 'DoorDash',
  ubereats: 'UberEats',
  other: 'Other',
};

const STATUS_MESSAGES = {
  received:   '📥 We got your order and are reviewing it!',
  picking_up: '🏃 We\'re picking it up now.',
  on_the_way: '🛵 On the way to you!',
  delivered:  '✅ Delivered!',
};

/**
 * Customer sends an image (order screenshot).
 * Sets state to awaiting_ss_check — admin must send SSCHECKED <phone> to proceed.
 */
async function handleImage(customer, mediaUrl) {
  const phone = customer.phone;

  const order = await createOrder(customer.id, mediaUrl);
  if (!order) {
    await sendMessage(phone, "Sorry, something went wrong saving your order. Please try again!");
    return;
  }

  await setCustomerState(phone, 'awaiting_ss_check');
  await sendMessage(phone, "📸 Got it! We're reviewing your order now — we'll message you shortly.");

  const shortPhone = phone.replace('whatsapp:', '');
  const caption =
    `📸 NEW SCREENSHOT\n` +
    `Customer: ${shortPhone}\n` +
    `Screenshot: ${order.screenshot_url}\n\n` +
    `SSCHECKED ${shortPhone}\n` +
    `BADSS ${shortPhone}`;
  await Promise.all(ADMINS.map(admin => sendMessage(admin, caption)));
}

/**
 * Customer replies with 1/2/3 to indicate platform.
 * state: awaiting_platform
 */
async function handlePlatformReply(customer, body) {
  const phone = customer.phone;
  const key = body.trim();
  const platform = PLATFORM_MAP[key];

  if (!platform) {
    await sendMessage(phone, "Please reply with 1 for DoorDash, 2 for UberEats, or 3 for Other.");
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(phone, "Something went wrong — couldn't find your order. Please send the screenshot again.");
    await setCustomerState(phone, 'idle');
    return;
  }

  await updateOrderPlatform(order.id, platform);
  await setCustomerState(phone, 'awaiting_address');
  await sendMessage(phone, 'Perfect! What\'s the delivery address? 📍');
}

/**
 * Customer replies with delivery address.
 * state: awaiting_address
 */
async function handleAddressReply(customer, body) {
  const phone = customer.phone;
  const address = body.trim();

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(phone, "Something went wrong — couldn't find your order. Please send the screenshot again.");
    await setCustomerState(phone, 'idle');
    return;
  }

  await updateOrderAddress(order.id, address);
  await setCustomerState(phone, 'awaiting_acceptance');
  await sendMessage(phone, "Got your address! 📍 Checking serviceability — we'll confirm shortly.");

  // Notify only the claiming admin (whoever did SSCHECKED), or all admins if unclaimed
  const platformLabel = PLATFORM_LABELS[order.platform] || 'Unknown';
  const shortPhone = phone.replace('whatsapp:', '');
  const adminMsg =
    `📍 ADDRESS RECEIVED\n` +
    `Customer: ${shortPhone}\n` +
    `Platform: ${platformLabel}\n` +
    `Address: ${address}\n` +
    `Screenshot: ${order.screenshot_url}\n\n` +
    `BADAD ${shortPhone}\n` +
    `ACCEPT ${shortPhone}\n` +
    `REJECT-FAR ${shortPhone}\n` +
    `REJECT-FULL ${shortPhone}\n` +
    `CONFIRM ${shortPhone} <mins> <driver>\n` +
    `OTW ${shortPhone}\n` +
    `DONE ${shortPhone}`;

  const claimant = getClaimant(phone);
  const recipients = claimant ? [claimant] : ADMINS;
  await Promise.all(recipients.map(admin => sendMessage(admin, adminMsg)));
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
  handlePlatformReply,
  handleAddressReply,
  handleCustomerStatusQuery,
};
