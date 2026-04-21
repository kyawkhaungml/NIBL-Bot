'use strict';

const cron = require('node-cron');
const { getAllActiveCustomers, getAddressRejectedExpired, setCustomerState } = require('./db');
const { send7DayNudge, send14DayNudge } = require('./flows/reengagement');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Daily re-engagement job — runs at 6pm (server timezone).
 * - Customers with no order in 7+ days get a nudge.
 * - Customers with no order in 14+ days get the deal prompt instead.
 */
cron.schedule('0 18 * * *', async () => {
  console.log(`[scheduler] Running re-engagement job at ${new Date().toISOString()}`);

  let customers;
  try {
    customers = await getAllActiveCustomers();
  } catch (err) {
    console.error('[scheduler] Failed to fetch active customers:', err.message);
    return;
  }

  const now = Date.now();
  let nudged7 = 0;
  let nudged14 = 0;

  for (const c of customers) {
    const lastActive = c.last_active_at ? new Date(c.last_active_at).getTime() : 0;
    const daysSince = (now - lastActive) / MS_PER_DAY;

    // re-engagement nudges disabled
    if (false && daysSince >= 14) {
      await send14DayNudge(c);
      nudged14++;
    } else if (false && daysSince >= 7) {
      await send7DayNudge(c);
      nudged7++;
    }
  }

  console.log(`[scheduler] Re-engagement done — 7-day: ${nudged7}, 14-day: ${nudged14}`);
});

console.log('[scheduler] Re-engagement cron registered (daily at 18:00)');

/**
 * Hourly job — resets customers whose address was rejected more than 24h ago
 * back to awaiting_address so they can try again.
 */
cron.schedule('0 * * * *', async () => {
  console.log(`[scheduler] Running address_rejected reset at ${new Date().toISOString()}`);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const customers = await getAddressRejectedExpired(cutoff);

  let reset = 0;
  for (const c of customers) {
    try {
      await setCustomerState(c.phone, 'awaiting_address');
      reset++;
    } catch (err) {
      console.error(`[scheduler] failed to reset ${c.phone}:`, err.message);
    }
  }

  console.log(`[scheduler] address_rejected reset done — reset ${reset} customer(s)`);
});

console.log('[scheduler] address_rejected reset cron registered (hourly)');
