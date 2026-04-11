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
    'Welcome to NIBL 🎉 You\'re in! Here\'s how it works:',
    'Order anything on DoorDash or UberEats → screenshot your order → text it here. We pick it up, deliver it to you for FREE, and include a surprise drink 🥤',
    'Ready? Just send us your order screenshot whenever you\'re ready. We\'re available 11am–10pm daily. Reply HELP anytime for assistance.',
  ]);

  await upsertCustomer(phone, { status: 'active' });
  await setCustomerState(phone, 'idle');
}

module.exports = { handleUnknown, handleInvited };
