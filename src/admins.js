'use strict';

const ADMINS = [
  process.env.OPERATOR_WHATSAPP,
  process.env.OPERATOR_WHATSAPP_2,
].filter(Boolean);

function isAdmin(from) {
  return ADMINS.includes(from);
}

module.exports = { ADMINS, isAdmin };
