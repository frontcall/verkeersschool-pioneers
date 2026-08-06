import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edward-Timestamp, X-Edward-Signature',
  'Content-Type': 'application/json',
};

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

// Constant-time compare of two equal-or-unequal-length strings.
// Normalises length by HMAC-ing both sides with a random key first,
// so timingSafeEqual never throws on a length mismatch and no early
// return leaks how much of the signature matched.
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

function uuid() {
  return crypto.randomUUID();
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getRawBody(event) {
  if (event.isBase64Encoded) {
    return Buffer.from(event.body || '', 'base64').toString('utf8');
  }
  return event.body || '';
}

function verifySignature(rawBody, headers, secret) {
  const timestamp = headers['x-edward-timestamp'];
  const signature = headers['x-edward-signature'];

  if (!timestamp || !signature || !secret) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return safeEqual(expected, signature);
}

function siteBaseUrl() {
  const fromEnv = (process.env.EDWARD_SITE_URL || '').replace(/\/$/, '');
  return fromEnv || 'https://verkeersschoolpioneers.nl';
}

async function upsertPost(data) {
  const {
    edward_article_id = '',
    title = '',
    slug: incomingSlug = '',
    content = '',
    status = 'published',
    meta_description = '',
    focus_keyword = '',
    tags = [],
    featured_image_url = '',
    featured_image_alt = '',
    og_title = '',
    og_description = '',
    og_image_url = '',
    twitter_title = '',
    twitter_description = '',
  } = data || {};

  const store = getStore({ name: 'posts', consistency: 'strong' });
  const now = new Date().toISOString();

  // Resolve external_id -> existing post id
  let existingId = null;
  let isUpdate = false;
  if (edward_article_id) {
    try {
      const extEntry = await store.get(`ext:${edward_article_id}`, { type: 'text' });
      if (extEntry) { existingId = extEntry; isUpdate = true; }
    } catch { /* not found */ }
  }

  const postId = existingId || uuid();

  let existing = null;
  if (isUpdate) {
    try {
      existing = await store.get(`post:${postId}`, { type: 'json' });
    } catch { /* treat as new */ }
  }

  // Resolve slug — use incoming or existing or generate from title
  let baseSlug = incomingSlug || existing?.slug || slugify(title) || postId;
  let finalSlug = baseSlug;

  const previousSlug = existing?.slug;
  if (finalSlug !== previousSlug) {
    try {
      const slugOwner = await store.get(`slug:${finalSlug}`, { type: 'text' });
      if (slugOwner && slugOwner !== postId) {
        finalSlug = `${baseSlug}-${postId.slice(0, 6)}`;
      }
    } catch { /* slug is free */ }
  }

  const post = {
    id: postId,
    external_id: edward_article_id,
    title,
    slug: finalSlug,
    body_html: content,
    excerpt: meta_description,
    meta_description,
    focus_keyword,
    tags: Array.isArray(tags) ? tags : [],
    featured_image_url,
    featured_image_alt,
    og_title: og_title || title,
    og_description: og_description || meta_description,
    og_image_url: og_image_url || featured_image_url,
    twitter_title: twitter_title || og_title || title,
    twitter_description: twitter_description || og_description || meta_description,
    status,
    published_at: existing?.published_at || now,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await store.set(`post:${postId}`, JSON.stringify(post));

  if (previousSlug && previousSlug !== finalSlug) {
    try { await store.delete(`slug:${previousSlug}`); } catch { /* ok */ }
  }
  await store.set(`slug:${finalSlug}`, postId);

  if (edward_article_id) {
    await store.set(`ext:${edward_article_id}`, postId);
  }

  let index = [];
  try {
    const raw = await store.get('_index', { type: 'json' });
    if (Array.isArray(raw)) index = raw;
  } catch { /* empty index */ }

  const summary = {
    id: postId,
    slug: finalSlug,
    title,
    excerpt: meta_description,
    featured_image_url,
    published_at: post.published_at,
    status,
  };

  const existingIdx = index.findIndex((p) => p.id === postId);
  if (existingIdx >= 0) {
    index[existingIdx] = summary;
  } else {
    index.unshift(summary);
  }
  index.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  await store.set('_index', JSON.stringify(index));

  return { postId, slug: finalSlug, isUpdate };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const rawBody = getRawBody(event);
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  const secret = process.env.EDWARD_WEBHOOK_SECRET || '';
  if (!verifySignature(rawBody, headers, secret)) {
    return json(401, { ok: false, error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { event: eventType, data } = body || {};

  if (eventType === 'ping') {
    return json(200, { ok: true });
  }

  if (eventType === 'article.published') {
    if (!data || typeof data !== 'object') {
      return json(400, { ok: false, error: 'Missing data' });
    }

    const { postId, slug, isUpdate } = await upsertPost(data);
    const postUrl = `${siteBaseUrl()}/blog/${slug}`;

    return json(200, {
      external_id: postId,
      post_url: postUrl,
      duplicate: isUpdate,
    });
  }

  return json(400, { ok: false, error: `Unknown event type: ${eventType}` });
};
