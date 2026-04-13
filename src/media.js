'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = 'screenshots';

/**
 * Downloads a Twilio-authenticated media URL and re-uploads it to
 * Supabase Storage as a publicly accessible file.
 * Returns the public URL, or the original twilioUrl as fallback if upload fails.
 */
async function uploadMedia(twilioUrl, contentType = 'image/jpeg') {
  try {
    const response = await fetch(twilioUrl, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64'),
      },
    });

    if (!response.ok) throw new Error(`Twilio media fetch failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = contentType.split('/')[1] || 'jpg';
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType, upsert: false });

    if (error) throw error;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    console.log(`[media] Uploaded to Supabase Storage: ${data.publicUrl}`);
    return data.publicUrl;
  } catch (err) {
    console.error('[media] uploadMedia failed:', err.message);
    return twilioUrl; // fall back so the flow isn't blocked
  }
}

module.exports = { uploadMedia };
