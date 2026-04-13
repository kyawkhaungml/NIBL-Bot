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
 */
async function handleImage(customer, mediaUrl) {
  const phone = customer.phone;

  const order = await createOrder(customer.id, mediaUrl);
  if (!order) {
    await sendMessage(phone, "Sorry, something went wrong saving your order. Please try again!");
    return;
  }

  await setCustomerState(phone, 'awaiting_platform');
  await sendMessage(
    phone,
    'Got it! 📸 We can see your order. What platform is this from?\n\nReply:\n1 — DoorDash\n2 — UberEats\n3 — Other'
  );
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
  await setCustomerState(phone, 'idle');

  await sendMessage(
    phone,
    "✅ Order accepted — first order 👀\nYou're all set. We're picking it up now."
  );

  // Forward to operator with quick-reply commands
  const platformLabel = PLATFORM_LABELS[order.platform] || 'Unknown';
  const shortPhone = phone.replace('whatsapp:', '');
  const operatorMsg =
    `NEW ORDER 🛵\n` +
    `Customer: ${shortPhone}\n` +
    `Platform: ${platformLabel}\n` +
    `Address: ${address}\n` +
    `Screenshot: ${order.screenshot_url}\n\n` +
    `Quick commands:\n` +
    `CONFIRM ${shortPhone} <mins> <driver>\n` +
    `OTW ${shortPhone}\n` +
    `DONE ${shortPhone}`;

  await Promise.all(ADMINS.map(admin => sendMessage(admin, operatorMsg)));
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
