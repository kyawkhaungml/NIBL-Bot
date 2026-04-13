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
 * STATUS <phone> <new_status>
 * Updates the latest order for a customer and optionally texts the customer.
 */
async function handleStatus(operatorPhone, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(operatorPhone, 'Usage: STATUS <phone> <status>\nStatuses: received | picking_up | on_the_way | delivered');
    return;
  }

  let [rawPhone, newStatus] = parts;
  // Normalise phone — allow operator to type just +12125551234
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const validStatuses = ['received', 'picking_up', 'on_the_way', 'delivered'];
  if (!validStatuses.includes(newStatus)) {
    await sendMessage(operatorPhone, `Invalid status "${newStatus}". Use one of: ${validStatuses.join(', ')}`);
    return;
  }

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  await updateOrderStatus(order.id, newStatus);

  if (newStatus === 'on_the_way') {
    claimCustomer(rawPhone, operatorPhone);
    await sendMessage(
      customer.phone,
      "Your order is on the way! 🛵 Inside your bag is a surprise from us 👀"
    );
    await sendMessage(operatorPhone, `✅ Status updated. Notified ${rawPhone}.`);
  } else if (newStatus === 'delivered') {
    releaseCustomer(rawPhone);
    await startFeedback(customer.phone);
    await sendMessage(operatorPhone, `✅ Status updated. Feedback prompt sent to ${rawPhone}.`);
  } else {
    await sendMessage(operatorPhone, `✅ Order status updated to "${newStatus}" for ${rawPhone}.`);
  }
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
 * SSCHECKED <phone>
 * Admin has verified the screenshot — triggers the platform question to the customer.
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
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await setCustomerState(rawPhone, 'awaiting_platform');
  await sendMessage(
    rawPhone,
    'Your order screenshot is verified! 📸 What platform is this from?\n\nReply:\n1 — DoorDash\n2 — UberEats\n3 — Other'
  );
  await sendMessage(operatorPhone, `✅ Screenshot approved. Platform question sent to ${rawPhone}.`);
}

/**
 * ACCEPT <phone>
 * Admin has confirmed serviceability — sends the order confirmation to the customer.
 */
async function handleAccept(operatorPhone, args) {
  let rawPhone = args.trim();
  if (!rawPhone) {
    await sendMessage(operatorPhone, 'Usage: ACCEPT <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  const order = await getLatestOrder(customer.id);
  if (!order) {
    await sendMessage(operatorPhone, `No orders found for ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await updateOrderStatus(order.id, 'picking_up');
  await setCustomerState(rawPhone, 'idle');
  await sendMessage(
    rawPhone,
    "✅ Order accepted — first order 👀\nYou're all set. We're picking it up now."
  );
  await sendMessage(operatorPhone, `✅ Order accepted. Confirmation sent to ${rawPhone}.`);
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
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
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
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
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
 * BADSS <phone>
 * Tells the customer their screenshot was unclear and asks them to resend.
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
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  releaseCustomer(rawPhone);
  await setCustomerState(rawPhone, 'idle');
  await sendMessage(
    rawPhone,
    "❌ Need a clearer screenshot\nMake sure it shows:\n • All items ordered\n • Total price\n • Delivery address\nSend it again and we'll take another look 👇"
  );
  await sendMessage(operatorPhone, `✅ Bad screenshot message sent to ${rawPhone}.`);
}
/**
 * BADAD <phone>
 * Tells the customer their address was not valid and asks them to resend.
 */
async function handleBadAD(operatorPhone, args){
  let rawPhone = args.trim();
  if(!rawPhone){
    await sendMessage(operatorPhone, 'Usage: BADAD <phone>');
    return;
  }
  if (!rawPhone.startsWith('whatsapp:')) rawPhone = `whatsapp:${rawPhone}`;

  const customer = await getCustomerByPhone(rawPhone);
  if (!customer) {
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  releaseCustomer(rawPhone);
  await setCustomerState(rawPhone, 'idle');
  await sendMessage(
    rawPhone,
    "❌ Need a valid address\nPlease check the address you sent and make sure it's correct.\nSend it again and we'll take another look 👇"
  );
  await sendMessage(operatorPhone, `✅ Bad address message sent to ${rawPhone}.`);
}
/**
 * CONFIRM <phone> <eta_minutes> <driver_name>
 * Sends the ETA + driver message to the customer after order is accepted.
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
    await sendMessage(operatorPhone, `Customer not found: ${rawPhone}`);
    return;
  }

  claimCustomer(rawPhone, operatorPhone);
  await sendMessage(
    customer.phone,
    `🕒 ETA: ${etaMinutes} minutes\n🚗 Driver: ${driverName}\nWe'll update you when we're en route.`
  );
  await sendMessage(operatorPhone, `✅ Confirmed for ${rawPhone}.`);
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
    case 'SSCHECKED':    return handleSSChecked(from, args);
    case 'BADSS':        return handleBadSS(from, args);
    case 'BADAD':        return handleBadAD(from, args);
    case 'ACCEPT':       return handleAccept(from, args);
    case 'REJECT-FAR':   return handleRejectFar(from, args);
    case 'REJECT-FULL':  return handleRejectFull(from, args);
    case 'STATUS':       return handleStatus(from, args);
    // Shorthand: OTW <phone> → marks on_the_way and texts customer
    case 'OTW':       return handleStatus(from, `${args} on_the_way`);
    // Shorthand: DONE <phone> → marks delivered and starts feedback
    case 'DONE':      return handleStatus(from, `${args} delivered`);
    case 'CONFIRM':   return handleConfirm(from, args);
    case 'MSG':       return handleMsg(from, args);
    case 'BROADCAST': return handleBroadcast(from, args);
    case 'INVITE':    return handleInvite(from, args);
    case 'WAITLIST':  return handleWaitlist(from);
    case 'STATS':     return handleStats(from);
    case 'HELP':
    default:
      await sendMessage(
        from,
        'Operator commands:\nSSCHECKED <phone> — approve screenshot\nBADSS <phone> — unclear screenshot, ask to resend\nBADAD <phone> — invalid address, ask to resend\nACCEPT <phone> — confirm order serviceability\nREJECT-FAR <phone> — reject: out of range\nREJECT-FULL <phone> — reject: window full\nCONFIRM <phone> <mins> <driver> — send ETA + driver\nOTW <phone> — order on the way\nDONE <phone> — mark delivered\nMSG <phone> <text> — send custom message\nINVITE <phone>\nBROADCAST <msg>\nWAITLIST\nSTATS'
      );
  }
}

module.exports = { handleOperatorMessage };
