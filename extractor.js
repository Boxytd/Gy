"use strict";
/*
Stateless extractor:
- Does not mutate module-level BASEDOM.
- Uses fetchWithTimeout with aborts, retries, and backoff.
- Limits parallelism for rcp fetches to avoid overload/hangs.
- Skips broken entries and always returns quickly on failures.
*/

const cheerio = require('cheerio');
const { fetchAndParseHLS } = require('./hls-utils');

const SOURCE_URL = 'https://vidsrc.xyz/embed';

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0"
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomizedHeaders(baseDomain) {
  const ua = getRandomUserAgent();
  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': ua,
    'Referer': (baseDomain ? baseDomain : 'https://cloudnestra.com') + '/',
    'Referrer-Policy': 'origin'
  };
  return headers;
}

// fetch with timeout & retries, returns response or throws
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000, retries = 2) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, ...options });
      clearTimeout(timer);
      if (!resp || !resp.ok) {
        lastErr = new Error('HTTP ' + (resp ? resp.status : 'NO_RESPONSE') + ' for ' + url);
        // do not retry on 4xx
        if (resp && resp.status >= 400 && resp.status < 500) throw lastErr;
      } else {
        return resp;
      }
    } catch (err) {
      lastErr = err;
      if (attempt > retries) throw lastErr;
      // exponential backoff small delay
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
  throw lastErr;
}

function getObject(id) {
  const arr = String(id || '').split(':');
  return { id: arr[0], season: arr[1], episode: arr[2] };
}

function getUrl(id, type) {
  if (type === 'movie') return `${SOURCE_URL}/movie/${id}`;
  const obj = getObject(id);
  return `${SOURCE_URL}/tv/${obj.id}/${obj.season}-${obj.episode}`;
}

async function serversLoad(html) {
  // Return servers + inferred baseDomain without touching module state.
  try {
    const $ = cheerio.load(html || '');
    const servers = [];
    const title = ($('title').text() || '').trim();
    const iframeSrc = $('iframe').attr('src') || '';
    let baseDomain = 'https://cloudnestra.com';
    try {
      if (iframeSrc) {
        const full = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;
        baseDomain = new URL(full).origin;
      }
    } catch (e) {
      // leave baseDomain fallback
    }
    $('.serversList .server').each((i, el) => {
      try {
        const server = $(el);
        servers.push({ name: server.text().trim(), dataHash: server.attr('data-hash') || null });
      } catch (e) { /* ignore malformed server element */ }
    });
    return { servers, title, baseDomain };
  } catch (e) {
    console.error('serversLoad error', e);
    return { servers: [], title: '', baseDomain: 'https://cloudnestra.com' };
  }
}

async function PRORCPhandler(baseDomain, prorcp) {
  if (!prorcp) return null;
  try {
    const url = `${baseDomain}/prorcp/${prorcp}`;
    const resp = await fetchWithTimeout(url, { headers: getRandomizedHeaders(baseDomain) }, 7000, 1);
    if (!resp || !resp.ok) return null;
    const text = await resp.text();
    const regex = /file:\s*'([^']*)'/m;
    const m = regex.exec(text);
    return (m && m[1]) ? m[1] : null;
  } catch (e) {
    console.error('PRORCPhandler failed', e && e.message ? e.message : e);
    return null;
  }
}

async function rcpGrabber(html) {
  try {
    const regex = /src:\s*'([^']*)'/m;
    const match = (html || '').match(regex);
    if (!match) return null;
    return { metadata: { image: '' }, data: match[1] };
  } catch (e) {
    return null;
  }
}

// concurrency helper to run promises with a concurrency limit
async function mapWithConcurrencyLimit(items, fn, limit = 5) {
  const results = [];
  let i = 0;
  const workers = new Array(limit).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function getStreamContent(id, type) {
  const url = getUrl(id, type);
  let embedText = '';
  try {
    const embedResp = await fetchWithTimeout(url, { headers: getRandomizedHeaders() }, 9000, 2);
    if (!embedResp || !embedResp.ok) return [];
    embedText = await embedResp.text();
  } catch (e) {
    console.error('failed to fetch embed page', e && e.message ? e.message : e);
    return [];
  }

  const { servers, title, baseDomain } = await serversLoad(embedText);
  if (!servers || servers.length === 0) return [];

  // Fetch rcp endpoints with concurrency limit and guard each fetch
  const rcpResponses = await mapWithConcurrencyLimit(servers, async (srv) => {
    if (!srv || !srv.dataHash) return null;
    try {
      const rcpResp = await fetchWithTimeout(`${baseDomain}/rcp/${srv.dataHash}`, { headers: getRandomizedHeaders(baseDomain) }, 9000, 2);
      if (!rcpResp || !rcpResp.ok) return null;
      const txt = await rcpResp.text();
      return await rcpGrabber(txt);
    } catch (e) {
      console.error('rcp fetch/parse failed for', srv.dataHash, e && e.message ? e.message : e);
      return null;
    }
  }, 4); // limit parallelism

  const apiResponse = [];
  for (const item of rcpResponses) {
    if (!item) continue;
    try {
      if (String(item.data || '').startsWith('/prorcp/')) {
        const streamUrl = await PRORCPhandler(baseDomain, String(item.data).replace('/prorcp/', ''));
        if (!streamUrl) continue;
        const hlsData = await fetchAndParseHLS(streamUrl);
        apiResponse.push({ name: title, image: item.metadata.image, mediaId: id, stream: streamUrl, referer: baseDomain, hlsData });
      }
    } catch (e) {
      console.error('processing rcp item failed', e);
      // continue to next
    }
  }

  return apiResponse;
}

module.exports = { getUrl, getStreamContent };
