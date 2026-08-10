// Legacy publish endpoint — static shared-key auth (X-Edward-Key).
//
// Superseded by edward-webhook.js, which uses HMAC request signing. Kept so any
// existing Edward configuration pointing here keeps working; it now shares the
// same concurrency-safe storage layer. Fails closed when EDWARD_KEY is unset.
// Safe to delete once Edward is confirmed to be using /api/edward-webhook.

import crypto from 'node:crypto';
import { upsertPost } from '../lib/posts.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edward-Key',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

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

function siteBaseUrl() {
  const raw = (process.env.EDWARD_SITE_URL || process.env.URL || 'https://verkeersschoolpioneers.nl')
    .trim()
    .replace(/\/+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  const edwardKey = process.env.EDWARD_KEY || '';
  const incomingKey = headers['x-edward-key'] || '';
  if (!edwardKey || !safeEqual(incomingKey, edwardKey)) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, site_name: 'Verkeersschool Pioneers', version: '1.0.0' });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { ok: false, error: 'Invalid JSON body' });
    }

    try {
      const { postId, slug, isUpdate } = await upsertPost(body);
      return json(200, {
        ok: true,
        post_id: postId,
        slug,
        duplicate: isUpdate,
        post_url: `${siteBaseUrl()}/blog/${slug}`,
      });
    } catch (error) {
      console.error('[edward-publish] upsert failed:', error?.message || error);
      return json(500, { ok: false, error: 'Failed to store post' });
    }
  }

  return json(405, { ok: false, error: 'Method not allowed' });
};
