'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Customer helpers ────────────────────────────────────────────────────────

async function getCustomerByPhone(phone) {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .single();
    if (error && error.code === 'PGRST116') return null; // not found
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[db] getCustomerByPhone:', err.message);
    return null;
  }
}

async function upsertCustomer(phone, fields) {
  try {
    const { data, error } = await supabase
      .from('customers')
      .upsert({ phone, ...fields }, { onConflict: 'phone' })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[db] upsertCustomer:', err.message);
    return null;
  }
}

async function setCustomerState(phone, state) {
  try {
    const { error } = await supabase
      .from('customers')
      .update({ state })
      .eq('phone', phone);
    if (error) throw error;
  } catch (err) {
    console.error('[db] setCustomerState:', err.message);
  }
}

async function getAllActiveCustomers() {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('status', 'active');
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[db] getAllActiveCustomers:', err.message);
    return [];
  }
}

async function getWaitlistCustomers() {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, phone, name, created_at')
      .eq('status', 'waitlist')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[db] getWaitlistCustomers:', err.message);
    return [];
  }
}

// ─── Order helpers ───────────────────────────────────────────────────────────

async function createOrder(customerId, screenshotUrl) {
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert({ customer_id: customerId, screenshot_url: screenshotUrl, status: 'received' })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[db] createOrder:', err.message);
    return null;
  }
}

async function getLatestOrder(customerId) {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error && error.code === 'PGRST116') return null;
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[db] getLatestOrder:', err.message);
    return null;
  }
}

async function updateOrderStatus(orderId, status) {
  try {
    const fields = { status };
    if (status === 'delivered') fields.delivered_at = new Date().toISOString();
    const { error } = await supabase
      .from('orders')
      .update(fields)
      .eq('id', orderId);
    if (error) throw error;
  } catch (err) {
    console.error('[db] updateOrderStatus:', err.message);
  }
}

async function updateOrderPlatform(orderId, platform) {
  try {
    const { error } = await supabase
      .from('orders')
      .update({ platform })
      .eq('id', orderId);
    if (error) throw error;
  } catch (err) {
    console.error('[db] updateOrderPlatform:', err.message);
  }
}

async function updateOrderAddress(orderId, address) {
  try {
    const { error } = await supabase
      .from('orders')
      .update({ delivery_address: address, status: 'picking_up' })
      .eq('id', orderId);
    if (error) throw error;
  } catch (err) {
    console.error('[db] updateOrderAddress:', err.message);
  }
}

// ─── Feedback helpers ────────────────────────────────────────────────────────

async function createFeedback(orderId, customerId, rating) {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .insert({ order_id: orderId, customer_id: customerId, rating })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[db] createFeedback:', err.message);
    return null;
  }
}

// ─── Drink interaction helpers ───────────────────────────────────────────────

async function logDrinkInteraction(orderId, customerId, brand = 'unknown') {
  try {
    const { error } = await supabase
      .from('qr_scans')
      .insert({ order_id: orderId, customer_id: customerId, brand });
    if (error) throw error;
  } catch (err) {
    console.error('[db] logDrinkInteraction:', err.message);
  }
}

// ─── Broadcast helpers ───────────────────────────────────────────────────────

async function logBroadcast(message, sentTo, createdBy) {
  try {
    const { error } = await supabase
      .from('broadcasts')
      .insert({ message, sent_to: sentTo, created_by: createdBy });
    if (error) throw error;
  } catch (err) {
    console.error('[db] logBroadcast:', err.message);
  }
}

// ─── Stats helper ────────────────────────────────────────────────────────────

async function getStats() {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    const [activeRes, todayRes, weekRes, ratingRes] = await Promise.all([
      supabase.from('customers').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
      supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', weekStart.toISOString()),
      supabase.from('feedback').select('rating'),
    ]);

    const ratings = (ratingRes.data || []).map(r => r.rating);
    const avgRating = ratings.length > 0
      ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)
      : 'N/A';

    return {
      activeCount: activeRes.count || 0,
      ordersToday: todayRes.count || 0,
      ordersWeek: weekRes.count || 0,
      avgRating,
    };
  } catch (err) {
    console.error('[db] getStats:', err.message);
    return { activeCount: 0, ordersToday: 0, ordersWeek: 0, avgRating: 'N/A' };
  }
}

// ─── Referral helpers ────────────────────────────────────────────────────────

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'NIBL';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function ensureReferralCode(customerId) {
  try {
    const { data: customer, error } = await supabase
      .from('customers')
      .select('referral_code')
      .eq('id', customerId)
      .single();
    if (error) throw error;
    if (customer.referral_code) return customer.referral_code;

    // Generate unique code
    let code;
    let attempts = 0;
    while (attempts < 10) {
      code = generateReferralCode();
      const { data: existing } = await supabase
        .from('customers')
        .select('id')
        .eq('referral_code', code)
        .single();
      if (!existing) break;
      attempts++;
    }

    const { error: updateError } = await supabase
      .from('customers')
      .update({ referral_code: code })
      .eq('id', customerId);
    if (updateError) throw updateError;
    return code;
  } catch (err) {
    console.error('[db] ensureReferralCode:', err.message);
    return null;
  }
}

module.exports = {
  getCustomerByPhone,
  upsertCustomer,
  setCustomerState,
  getAllActiveCustomers,
  getWaitlistCustomers,
  createOrder,
  getLatestOrder,
  updateOrderStatus,
  updateOrderPlatform,
  updateOrderAddress,
  createFeedback,
  logDrinkInteraction,
  logBroadcast,
  getStats,
  ensureReferralCode,
};
