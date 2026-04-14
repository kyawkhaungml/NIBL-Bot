'use strict';

const {
  getCustomerByPhone,
  upsertCustomer,
  getLatestOrder,
  updateOrderStatus,
  setCustomerState,
  getAllActiveCustomers,
  getWaitlistCustomers,
  logBroadcast,
  getStats,
} = require('../db');
const { sendMessage, delay } = require('../whatsapp');
const { ADMINS } = require('../admins');
const { claimCustomer, releaseCustomer } = require('../claims');
const { handleInvited } = require('./onboarding');
const { startFeedback } = require('./feedback');

/**
 * Parse an operator command from raw message body.
 * Returns { command, args } where command is uppercase and args is the rest.
 */
function parseCommand(body) {
  const trimmed = body.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { command: trimmed.toUpperCase(), args: '' };
  }
  return {
    command: trimmed.substring(0, spaceIdx).toUpperCase(),
    args: trimmed.substring(spaceIdx + 1).trim(),
  };
}

/**
 * Soft state warning — notifies operator that the customer may not be in the expected state.
 * The command still executes.
 */
async function sendStateWarning(operatorPhone, rawPhone, currentState) {
  await sendMessage(
    operatorPhone,
    `⚠️ ${rawPhone} is currently in state: ${currentState} — command may not be valid at this stage.`
  );
}

/**
 * CHECKAD <phone>
 * Admin approves delivery address — unlocks screenshot submission for customer.
 */
async function handleCheckAD(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: CHECKAD <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'awaiting_address_verification') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  claimCustomer(rawPhone, operatorPhone);
  await setCustomerState(rawPhone, 'awaiting_screenshot');
  await sendMessage(
    rawPhone,
    'Great news! ✅ We deliver to your area.\nNow send us a screenshot of your order on DoorDash or UberEats 📸'
  );
  await sendMessage(operatorPhone, `✅ Address approved. Screenshot prompt sent to ${rawPhone}.`);
}

/**
 * BADAD <phone>
 * Admin rejects delivery address — area not covered.
 * Customer is locked out for 24h, then auto-reset to awaiting_address.
 */
async function handleBadAD(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: BADAD <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'awaiting_address_verification') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  releaseCustomer(rawPhone);
  // Update last_active_at so the 24h scheduler timer is anchored to this moment
  await upsertCustomer(rawPhone, { last_active_at: new Date().toISOString() });
  await setCustomerState(rawPhone, 'address_rejected');
  await sendMessage(
    rawPhone,
    "Sorry 😔 We don't deliver to your area yet.\nWe're expanding soon — we'll let you know when you're covered!"
  );
  await sendMessage(operatorPhone, `✅ Rejection sent to ${rawPhone}.`);
}

/**
 * VALIDAD <phone>
 * Admin asks customer to resend a valid/complete delivery address.
 * State is reset to awaiting_address so the customer can reply with a new one.
 */
async function handleValidAD(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: VALIDAD <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'awaiting_address_verification') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  await setCustomerState(rawPhone, 'awaiting_address');
  await sendMessage(
    rawPhone,
    "We couldn't verify that address 🤔\nCould you double-check and send it again?\nMake sure to include your street, apartment number, and zip code 📍"
  );
  await sendMessage(operatorPhone, `✅ Address validation request sent to ${rawPhone}.`);
}

/**
 * SSCHECKED <phone>
 * Admin approves screenshot — customer is notified and state moves to awaiting_confirmation.
 */
async function handleSSChecked(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: SSCHECKED <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'awaiting_screenshot_verification') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await updateOrderStatus(order.id, 'screenshot_verified');
  await setCustomerState(rawPhone, 'awaiting_confirmation');
  await sendMessage(
    rawPhone,
    'Order looks good! ✅\nConfirming your order now — one moment 🙌'
  );
  await sendMessage(operatorPhone, `✅ Screenshot approved. Customer notified.`);
}

/**
 * BADSS <phone>
 * Admin rejects screenshot — customer is asked to resend.
 */
async function handleBadSS(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: BADSS <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (order) {
    await updateOrderStatus(order.id, 'screenshot_rejected');
  }

  releaseCustomer(rawPhone);
  await setCustomerState(rawPhone, 'awaiting_screenshot');
  await sendMessage(
    rawPhone,
    "Hmm, we couldn't read that screenshot clearly 😅\nCould you send it again? Make sure the full order is visible 📸"
  );
  await sendMessage(operatorPhone, `✅ Bad screenshot message sent to ${rawPhone}.`);
}

/**
 * CONFIRM <phone> <eta_minutes> <driver_name>
 * Sends ETA + driver to customer and moves order to confirmed state.
 */
async function handleConfirm(operatorPhone, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 3) {
    await sendMessage(operatorPhone, 'Usage: CONFIRM <phone> <eta_minutes> <driver_name>\nExample: CONFIRM +19172792972 25 John');
    return;
  }

  let [rawPhone, etaMinutes, ...driverParts] = parts;
  const driverName = driverParts.join(' ');

  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  if (isNaN(parseInt(etaMinutes, 10))) {
    await sendMessage(operatorPhone, `"${etaMinutes}" is not a valid number. Usage: CONFIRM <phone> <eta_minutes> <driver_name>`);
    return;
  }

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'awaiting_confirmation') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await updateOrderStatus(order.id, 'confirmed');
  await setCustomerState(rawPhone, 'order_confirmed');
  await sendMessage(
    customer.phone,
    `🕒 ETA: ${etaMinutes} minutes\n🚗 Driver: ${driverName}\nWe'll update you when we're en route.`
  );
  await sendMessage(operatorPhone, `✅ Confirmed for ${rawPhone}.`);
}

/**
 * OTW <phone>
 * Marks order as on the way and notifies customer.
 */
async function handleOTW(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: OTW <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'order_confirmed') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await updateOrderStatus(order.id, 'on_the_way');
  await setCustomerState(rawPhone, 'order_on_the_way');
  await sendMessage(rawPhone, "We've picked up your order and we're on the way! 🛵");
  await sendMessage(operatorPhone, `✅ Marked on the way. Customer notified.`);
}

/**
 * DONE <phone>
 * Marks order as delivered and starts feedback flow.
 */
async function handleDone(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: DONE <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  if (customer.state !== 'order_on_the_way') {
    await sendStateWarning(operatorPhone, rawPhone, customer.state);
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  releaseCustomer(rawPhone);
  await updateOrderStatus(order.id, 'delivered');
  await startFeedback(customer.phone);
  await sendMessage(operatorPhone, `✅ Status updated. Feedback prompt sent to ${rawPhone}.`);
}

/**
 * STATUS <phone> <new_status>
 * Manual status override for edge cases.
 */
async function handleStatus(operatorPhone, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(operatorPhone, 'Usage: STATUS <phone> <status>\nStatuses: screenshot_received | screenshot_verified | confirmed | on_the_way | delivered');
    return;
  }

  let [rawPhone, newStatus] = parts;
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const validStatuses = ['screenshot_received', 'screenshot_verified', 'screenshot_rejected', 'confirmed', 'on_the_way', 'delivered'];
  if (!validStatuses.includes(newStatus)) {
    await sendMessage(operatorPhone, `Invalid status "${newStatus}". Use one of: ${validStatuses.join(', ')}`);
    return;
  }

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  await updateOrderStatus(order.id, newStatus);
  await sendMessage(operatorPhone, `✅ Order status updated to "${newStatus}" for ${rawPhone}.`);
}

/**
 * REJECT-FAR <phone>
 * Rejects the order — drop-off is out of range.
 */
async function handleRejectFar(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: REJECT-FAR <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  releaseCustomer(rawPhone);
  await setCustomerState(rawPhone, 'idle');
  await sendMessage(
    rawPhone,
    "❌ Outside our current range\nThis drop-off is a bit too far for this run.\nWe'll be expanding zones soon — or try another order within range."
  );
  await sendMessage(operatorPhone, `✅ Rejection sent to ${rawPhone}.`);
}

/**
 * REJECT-FULL <phone>
 * Rejects the order — delivery window is full.
 */
async function handleRejectFull(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: REJECT-FULL <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `❌ Customer not found: ${rawPhone}`);
    return;
  }

  releaseCustomer(rawPhone);
  await setCustomerState(rawPhone, 'idle');
  await sendMessage(
    rawPhone,
    "❌ This window is full\nAll delivery slots for this time frame have been taken.\nNew slots open shortly — stay close 👀"
  );
  await sendMessage(operatorPhone, `✅ Rejection sent to ${rawPhone}.`);
}

/**
 * BROADCAST <message>
 * Sends a message to all active customers with rate-limit-safe 500ms delay.
 */
async function handleBroadcast(operatorPhone, args) {
  const message = args.trim();
  if (!message) {
    await sendMessage(operatorPhone, 'Usage: BROADCAST <your message>');
    return;
  }

  const customers = await getAllActiveCustomers();
  if (customers.length === 0) {
    await sendMessage(operatorPhone, 'No active customers to broadcast to.');
    return;
  }

  await sendMessage(operatorPhone, `📡 Sending broadcast to ${customers.length} customers...`);

  let sent = 0;
  for (const c of customers) {
    try {
      await sendMessage(c.phone, message);
      sent++;
    } catch (err) {
      console.error(`[operator] broadcast failed for ${c.phone}:`, err.message);
    }
    await delay(500);
  }

  await logBroadcast(message, sent, operatorPhone);
  await sendMessage(operatorPhone, `✅ Broadcast sent to ${sent}/${customers.length} customers.`);
}

/**
 * INVITE <phone>
 * Invites a phone number — sends welcome sequence immediately.
 */
async function handleInvite(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: INVITE <phone>  e.g. INVITE +12125551234');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const existing = await getCustomerByPhone(rawPhone);
  if (existing && existing.status === 'active') {
    await sendMessage(operatorPhone, `That number is already active: ${rawPhone}`);
    return;
  }

  const customer = await upsertCustomer(rawPhone, { status: 'invited' });
  await handleInvited(customer || { phone: rawPhone });
  await sendMessage(operatorPhone, `✅ Invited ${rawPhone} — welcome sequence sent.`);
}

/**
 * WAITLIST
 * Replies with a formatted list of all waitlist customers.
 */
async function handleWaitlist(operatorPhone) {
  const customers = await getWaitlistCustomers();
  if (customers.length === 0) {
    await sendMessage(operatorPhone, 'Waitlist is empty.');
    return;
  }

  const lines = customers.map((c, i) => {
    const name = c.name || '(no name)';
    return `${i + 1}. ${name} — ${c.phone}`;
  });
  await sendMessage(operatorPhone, `📋 Waitlist (${customers.length}):\n\n${lines.join('\n')}`);
}

/**
 * STATS
 * Replies with aggregate stats.
 */
function maskPhone(phone) {
  const raw = phone.replace('whatsapp:', '');
  return raw.slice(0, 2) + '******' + raw.slice(-4);
}

async function handleStats(operatorPhone) {
  const stats = await getStats();
  const adminList = ADMINS.map(maskPhone).join(', ');
  const msg = [
    '📊 NIBL Stats',
    `Active customers: ${stats.activeCount}`,
    `Orders today: ${stats.ordersToday}`,
    `Orders this week: ${stats.ordersWeek}`,
    `Avg rating: ${stats.avgRating} ⭐`,
    `Admins: ${adminList}`,
  ].join('\n');
  await sendMessage(operatorPhone, msg);
}

/**
 * MSG <phone> <message>
 * Manually send a custom message to a customer.
 */
async function handleMsg(operatorPhone, args) {
  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1) {
    await sendMessage(operatorPhone, 'Usage: MSG <phone> <your message>\nExample: MSG +19172792972 Running 10 min late, sorry!');
    return;
  }

  let rawPhone = args.substring(0, spaceIdx).trim();
  const message = args.substring(spaceIdx + 1).trim();

  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  if (!message) {
    await sendMessage(operatorPhone, 'Usage: MSG <phone> <your message>');
    return;
  }

  try {
    claimCustomer(rawPhone, operatorPhone);
    await sendMessage(rawPhone, message);
    await sendMessage(operatorPhone, `✅ Sent to ${rawPhone}`);
  } catch (err) {
    await sendMessage(operatorPhone, `❌ Failed to send: ${err.message}`);
  }
}

/**
 * Main entry point — routes operator commands.
 */
async function handleOperatorMessage(from, body) {
  const { command, args } = parseCommand(body);

  switch (command) {
    case 'CHECKAD':     return handleCheckAD(from, args);
    case 'VALIDAD':     return handleValidAD(from, args);
    case 'BADAD':       return handleBadAD(from, args);
    case 'SSCHECKED':   return handleSSChecked(from, args);
    case 'BADSS':       return handleBadSS(from, args);
    case 'CONFIRM':     return handleConfirm(from, args);
    case 'OTW':         return handleOTW(from, args);
    case 'DONE':        return handleDone(from, args);
    case 'REJECT-FAR':  return handleRejectFar(from, args);
    case 'REJECT-FULL': return handleRejectFull(from, args);
    case 'STATUS':      return handleStatus(from, args);
    case 'MSG':         return handleMsg(from, args);
    case 'BROADCAST':   return handleBroadcast(from, args);
    case 'INVITE':      return handleInvite(from, args);
    case 'WAITLIST':    return handleWaitlist(from);
    case 'STATS':       return handleStats(from);
    case 'HELP':
    default:
      await sendMessage(
        from,
        'Operator commands:\n' +
        'CHECKAD <phone> — approve address, unlock screenshot\n' +
        'VALIDAD <phone> — ask customer to resend valid address\n' +
        'BADAD <phone> — reject area (24h lockout)\n' +
        'SSCHECKED <phone> — approve screenshot\n' +
        'BADSS <phone> — unclear screenshot, ask to resend\n' +
        'CONFIRM <phone> <mins> <driver> — send ETA + driver\n' +
        'OTW <phone> — mark on the way\n' +
        'DONE <phone> — mark delivered + send feedback prompt\n' +
        'REJECT-FAR <phone> — reject: out of range\n' +
        'REJECT-FULL <phone> — reject: window full\n' +
        'STATUS <phone> <status> — manual status update\n' +
        'MSG <phone> <text> — send custom message\n' +
        'INVITE <phone>\n' +
        'BROADCAST <msg>\n' +
        'WAITLIST\n' +
        'STATS'
      );
  }
}

module.exports = { handleOperatorMessage };
