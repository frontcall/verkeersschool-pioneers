// Edward (SEO content tool) → blog webhook receiver.
//
// Public endpoint: https://verkeersschoolpioneers.nl/api/edward-webhook
//
// This is a Netlify Functions v2 handler with an explicit `path` in its config
// (see the export at the bottom). That matters: the Astro SSR function claims
// `/*`, so a netlify.toml rewrite to this endpoint would be swallowed by the
// catch-all before it ever ran. An explicit function path is matched directly.
//
// Edward signs each delivery with HMAC-SHA256 over `<timestamp>.<rawBody>`.
// We verify against the RAW bytes read straight off the request, before any
// JSON parsing — re-serialising the body would change it and break the
// signature.

import crypto from 'node:crypto';
import { upsertPost } from '../lib/posts.js';

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edward-Timestamp, X-Edward-Signature',
  'Content-Type': 'application/json',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

/**
 * Constant-time compare that tolerates unequal lengths.
 * Both sides are HMAC'd under a fresh random key first, so the digests are
 * always 32 bytes (timingSafeEqual throws on a length mismatch) and no early
 * return can leak how much of the signature matched.
 */
function safeEqual(a, b) {
  try {
    const key = crypto.randomBytes(32);
    const ha = crypto.createHmac('sha256', key).update(String(a)).digest();
    const hb = crypto.createHmac('sha256', key).update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

function verifySignature(rawBody, req, secret) {
  const timestamp = req.headers.get('x-edward-timestamp');
  const signature = req.headers.get('x-edward-signature');

  if (!timestamp || !signature || !secret) return false;
  if (!/^\d{1,15}$/.test(timestamp)) return false;

  // Replay protection — reject deliveries outside a 5 minute window.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(signed).digest('hex');

  return safeEqual(expected, signature);
}

/** Absolute https base URL — Edward stores post_url as the article's live link. */
function siteBaseUrl() {
  const raw = (process.env.EDWARD_SITE_URL || process.env.URL || 'https://verkeersschoolpioneers.nl')
    .trim()
    .replace(/\/+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  // The exact bytes Edward signed.
  const rawBody = Buffer.from(await req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'Payload too large' });
  }

  // Never logged, never echoed back.
  const secret = process.env.EDWARD_WEBHOOK_SECRET || '';
  if (!verifySignature(rawBody, req, secret)) {
    return json(401, { ok: false, error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { event: eventType, id: eventId = '', data } = body || {};

  if (eventType === 'ping') {
    return json(200, { ok: true });
  }

  if (eventType === 'article.published') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json(400, { ok: false, error: 'Missing data' });
    }

    try {
      const { postId, slug, isUpdate } = await upsertPost(data);
      console.log(
        `[edward] article.published event=${eventId} article=${data.edward_article_id || '-'} post=${postId} slug=${slug} update=${isUpdate}`,
      );

      return json(200, {
        external_id: postId,
        post_url: `${siteBaseUrl()}/blog/${slug}`,
        duplicate: isUpdate,
      });
    } catch (error) {
      console.error(`[edward] upsert failed event=${eventId}:`, error?.message || error);
      return json(500, { ok: false, error: 'Failed to store post' });
    }
  }

  return json(400, { ok: false, error: `Unknown event type: ${eventType}` });
};

// Explicit route. Netlify parses this statically, so it must stay a literal.
export const config = {
  path: '/api/edward-webhook',
};
