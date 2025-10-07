"use strict";
const { Parser } = require('m3u8-parser');

// local fetchWithTimeout; keep small retries and tight timeouts to avoid hanging
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000, retries = 1) {
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
        if (resp && resp.status >= 400 && resp.status < 500) throw lastErr;
      } else {
        return resp;
      }
    } catch (e) {
      lastErr = e;
      if (attempt > retries) throw lastErr;
      await new Promise(r => setTimeout(r, 150 * attempt));
    }
  }
  throw lastErr;
}

function parseHLSMaster(masterPlaylistContent, baseUrl) {
  try {
    const parser = new Parser();
    parser.push(masterPlaylistContent);
    parser.end();
    const manifest = parser.manifest;
    const qualities = [];
    if (manifest && Array.isArray(manifest.playlists) && manifest.playlists.length) {
      const sorted = manifest.playlists.slice().sort((a,b) => {
        const A = (a.attributes && Number(a.attributes.BANDWIDTH)) || 0;
        const B = (b.attributes && Number(b.attributes.BANDWIDTH)) || 0;
        return B - A;
      });
      for (const playlist of sorted) {
        const attrs = playlist.attributes || {};
        const playlistUrl = playlist.uri && playlist.uri.startsWith('http') ? playlist.uri : new URL(playlist.uri, baseUrl).toString();
        let title = 'Unknown Quality';
        const resolution = attrs.RESOLUTION ? `${attrs.RESOLUTION.width}x${attrs.RESOLUTION.height}` : undefined;
        if (resolution && attrs.RESOLUTION) {
          const h = Number(attrs.RESOLUTION.height || 0);
          if (h >= 1080) title = `${resolution} (1080p)`;
          else if (h >= 720) title = `${resolution} (720p)`;
          else if (h >= 480) title = `${resolution} (480p)`;
          else title = `${resolution}`;
        } else {
          const bandwidth = Number(attrs.BANDWIDTH || 0);
          title = bandwidth > 5000000 ? 'High Quality' : (bandwidth > 2000000 ? 'Medium Quality' : 'Low Quality');
        }
        qualities.push({ resolution, bandwidth: Number(attrs.BANDWIDTH||0), codecs: attrs.CODECS, frameRate: attrs['FRAME-RATE'], url: playlistUrl, title });
      }
    }
    return { masterUrl: baseUrl, qualities };
  } catch (e) {
    console.error('parseHLSMaster error', e);
    return null;
  }
}

async function fetchAndParseHLS(url) {
  try {
    const resp = await fetchWithTimeout(url, {}, 5000, 1);
    if (!resp || !resp.ok) return null;
    const content = await resp.text();
    if (!content || typeof content !== 'string') return null;
    if (!content.includes('#EXT-X-STREAM-INF')) return null;
    return parseHLSMaster(content, url);
  } catch (e) {
    console.error('fetchAndParseHLS failed', e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { parseHLSMaster, fetchAndParseHLS };
