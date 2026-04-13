'use strict';

/**
 * In-memory claim store: tracks which admin "owns" a customer's conversation.
 * Resets on server restart (acceptable — orders are short-lived).
 *
 * Key:   customer WhatsApp phone  (e.g. "whatsapp:+15551234567")
 * Value: admin WhatsApp phone     (e.g. "whatsapp:+19296468461")
 */
const claims = new Map();

/** Assign a customer conversation to an admin. */
function claimCustomer(customerPhone, adminPhone) {
  claims.set(customerPhone, adminPhone);
}

/** Release a customer conversation (order done or rejected). */
function releaseCustomer(customerPhone) {
  claims.delete(customerPhone);
}

/** Returns the admin who claimed this customer, or null if unclaimed. */
function getClaimant(customerPhone) {
  return claims.get(customerPhone) || null;
}

module.exports = { claimCustomer, releaseCustomer, getClaimant };
