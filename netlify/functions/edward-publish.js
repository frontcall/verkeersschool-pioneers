import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edward-Key',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

// Timing-safe comparison: HMAC both sides to normalise length before compare
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

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const edwardKey = process.env.EDWARD_KEY || '';
  const siteUrl   = (process.env.EDWARD_SITE_URL || '').replace(/\/$/, '');

  // Auth check
  const incomingKey = event.headers['x-edward-key'] || event.headers['X-Edward-Key'] || '';
  if (!edwardKey || !safeEqual(incomingKey, edwardKey)) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  // GET — health/info
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, site_name: 'Verkeersschool Pioneers', version: '1.0.0' });
  }

  // POST — upsert post
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { ok: false, error: 'Invalid JSON body' });
    }

    const {
      title           = '',
      content         = '',
      edward_article_id = '',
      slug: incomingSlug = '',
      status          = 'published',
      meta_description = '',
      focus_keyword   = '',
      tags            = [],
      featured_image_url = '',
      featured_image_alt = '',
      og_title        = '',
      og_description  = '',
      og_image_url    = '',
      twitter_title   = '',
      twitter_description = '',
    } = body;

    const store = getStore({ name: 'posts', consistency: 'strong' });

    const now = new Date().toISOString();

    // Resolve external_id → existing post id
    let existingId = null;
    let isUpdate   = false;
    if (edward_article_id) {
      try {
        const extEntry = await store.get(`ext:${edward_article_id}`, { type: 'text' });
        if (extEntry) { existingId = extEntry; isUpdate = true; }
      } catch { /* not found */ }
    }

    const postId = existingId || uuid();

    // Load existing post (for update) or start fresh
    let existing = null;
    if (isUpdate) {
      try {
        existing = await store.get(`post:${postId}`, { type: 'json' });
      } catch { /* treat as new */ }
    }

    // Resolve slug — use incoming or existing or generate from title
    let baseSlug = incomingSlug || (existing?.slug) || slugify(title) || postId;
    let finalSlug = baseSlug;
    let slugConflict = false;

    // Check slug uniqueness (only relevant if slug changes or new post)
    const previousSlug = existing?.slug;
    if (finalSlug !== previousSlug) {
      try {
        const slugOwner = await store.get(`slug:${finalSlug}`, { type: 'text' });
        if (slugOwner && slugOwner !== postId) {
          // Conflict — append short suffix
          finalSlug = `${baseSlug}-${postId.slice(0, 6)}`;
          slugConflict = true;
        }
      } catch { /* slug is free */ }
    }

    // Build post object
    const post = {
      id:                   postId,
      external_id:          edward_article_id,
      title,
      slug:                 finalSlug,
      body_html:            content,
      excerpt:              meta_description,
      meta_description,
      focus_keyword,
      tags:                 Array.isArray(tags) ? tags : [],
      featured_image_url,
      featured_image_alt,
      og_title:             og_title   || title,
      og_description:       og_description || meta_description,
      og_image_url:         og_image_url   || featured_image_url,
      twitter_title:        twitter_title  || og_title || title,
      twitter_description:  twitter_description || og_description || meta_description,
      status,
      published_at:         existing?.published_at || now,
      created_at:           existing?.created_at   || now,
      updated_at:           now,
    };

    // Persist post blob
    await store.set(`post:${postId}`, JSON.stringify(post));

    // Update slug index (remove old slug pointer if slug changed)
    if (previousSlug && previousSlug !== finalSlug) {
      try { await store.delete(`slug:${previousSlug}`); } catch { /* ok */ }
    }
    await store.set(`slug:${finalSlug}`, postId);

    // Update external_id index
    if (edward_article_id) {
      await store.set(`ext:${edward_article_id}`, postId);
    }

    // Update _index (summary list for listing page)
    let index = [];
    try {
      const raw = await store.get('_index', { type: 'json' });
      if (Array.isArray(raw)) index = raw;
    } catch { /* empty index */ }

    const summary = {
      id:                postId,
      slug:              finalSlug,
      title,
      excerpt:           meta_description,
      featured_image_url,
      published_at:      post.published_at,
      status,
    };

    const existingIdx = index.findIndex(p => p.id === postId);
    if (existingIdx >= 0) {
      index[existingIdx] = summary;
    } else {
      index.unshift(summary);
    }
    // Keep sorted newest first
    index.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

    await store.set('_index', JSON.stringify(index));

    const postUrl = siteUrl ? `${siteUrl}/blog/${finalSlug}` : null;

    return json(200, {
      ok:            true,
      post_id:       postId,
      slug:          finalSlug,
      slug_conflict: slugConflict,
      duplicate:     isUpdate,
      post_url:      postUrl,
    });
  }

  return json(405, { ok: false, error: 'Method not allowed' });
};
