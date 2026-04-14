'use strict';

const { upsertCustomer, setCustomerState } = require('../db');
const { sendMessage, sendMessages } = require('../whatsapp');

/**
 * Handle a message from a number that is not in the DB or is on the waitlist.
 * First contact: prompt for name.
 * Second contact (state=awaiting_name): save name and confirm.
 */
async function handleUnknown(phone, body, existingCustomer) {
  // If we already asked for their name, save it
  if (existingCustomer && existingCustomer.state === 'awaiting_name' && body.trim()) {
    const name = body.trim();
    await upsertCustomer(phone, { name, state: 'idle' });
    await sendMessage(
      phone,
      `Thanks, ${name}! 🙌 We've got you on the list. We'll reach out as soon as a spot opens up. Stay tuned!`
    );
    return;
  }

  // First contact — ask for name
  await upsertCustomer(phone, { status: 'waitlist', state: 'awaiting_name' });
  await sendMessage(
    phone,
    "Hey! 👋 We're NIBL — a free delivery service for invited members. You're not on our list yet. Want in? Drop your name and we'll add you to the waitlist."
  );
}

/**
 * Send the 3-part welcome sequence to a newly invited customer,
 * then mark them as active.
 */
async function handleInvited(customer) {
  const phone = customer.phone;

  await sendMessages(phone, [
    'Welcome to NIBL 🎉 You\'re in!',

    `Here's how it works:
1.Order on DoorDash or Uber Eats
2.Screenshot the full order (items + total + address)
3.Send it here
We'll pick it up and deliver it to you for free
🥤 Your first order includes a free drink
After that, we'll include drinks only when they match your order
Once you send your order, we'll confirm + send an ETA.
⚠️ Limited slots per time window`,
    
    "Whenever you're ready, type ORDER to place your first order 🛵",
  ]);

  await upsertCustomer(phone, { status: 'active' });
  await setCustomerState(phone, 'idle');
}

module.exports = { handleUnknown, handleInvited };
