-- NIBL Bot — Initial Schema
-- Run this in the Supabase SQL editor

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- customers
CREATE TABLE customers (
  id             uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  phone          text         UNIQUE NOT NULL,            -- E.164 e.g. whatsapp:+12125551234
  name           text,
  status         text         NOT NULL DEFAULT 'waitlist', -- waitlist | invited | active
  state          text,                                     -- conversation state machine
  invite_code    text,
  referral_code  text         UNIQUE,
  referred_by    uuid         REFERENCES customers(id),
  created_at     timestamptz  DEFAULT now(),
  last_active_at timestamptz  DEFAULT now()
);

-- orders
CREATE TABLE orders (
  id               uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id      uuid         NOT NULL REFERENCES customers(id),
  screenshot_url   text         NOT NULL,
  platform         text,                    -- doordash | ubereats | other
  status           text         DEFAULT 'received', -- received | picking_up | on_the_way | delivered
  drink_included   text,
  delivery_address text,
  operator_notes   text,
  discount_applied text,
  created_at       timestamptz  DEFAULT now(),
  delivered_at     timestamptz
);

-- feedback
CREATE TABLE feedback (
  id          uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id    uuid         NOT NULL REFERENCES orders(id),
  customer_id uuid         NOT NULL REFERENCES customers(id),
  rating      int          CHECK (rating >= 1 AND rating <= 5),
  comment     text,
  created_at  timestamptz  DEFAULT now()
);

-- broadcasts
CREATE TABLE broadcasts (
  id         uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  message    text         NOT NULL,
  sent_to    int          DEFAULT 0,
  sent_at    timestamptz  DEFAULT now(),
  created_by text
);

-- qr_scans (drink interaction tracking)
CREATE TABLE qr_scans (
  id          uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id    uuid         REFERENCES orders(id),
  customer_id uuid         REFERENCES customers(id),
  scanned_at  timestamptz  DEFAULT now(),
  brand       text
);

-- Indexes for common query patterns
CREATE INDEX ON customers(status);
CREATE INDEX ON customers(last_active_at);
CREATE INDEX ON orders(customer_id);
CREATE INDEX ON orders(status);
CREATE INDEX ON orders(created_at);
CREATE INDEX ON feedback(order_id);
CREATE INDEX ON feedback(customer_id);
