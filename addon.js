"use strict";
const { addonBuilder } = require('stremio-addon-sdk');
const { getStreamContent } = require('./extractor');

const manifest = {
  id: "xyz.theditor.stremsrc",
  version: "0.1.2-resettable",
  catalogs: [],
  resources: [
    { name: "stream", types: ["movie","series"], idPrefixes: ["tt"] }
  ],
  types: ["movie","series"],
  name: "stremsrc-stable-resettable",
  description: "VidSRC extractor (resettable, defensive)"
};

const builder = new addonBuilder(manifest);

// Safety hooks so thrown errors don't kill the runtime
process.on('unhandledRejection', (r) => { console.error('unhandledRejection', r); });
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); });

// Small wrapper to ensure each invocation has a bounded time and always returns.
builder.defineStreamHandler(async ({ id, type }) => {
  try {
    // getStreamContent is already defensive and resettable (no globals).
    const results = await getStreamContent(id, type);
    if (!Array.isArray(results) || results.length === 0) return { streams: [] };

    const streams = [];
    for (const st of results) {
      try {
        if (!st || !st.stream) continue;
        // HLS qualities (if present)
        if (st.hlsData && Array.isArray(st.hlsData.qualities) && st.hlsData.qualities.length) {
          streams.push({ title: `${st.name || 'Unknown'} - Auto Quality`, url: st.stream, behaviorHints: { notWebReady: true } });
          for (const q of st.hlsData.qualities) {
            if (!q || !q.url) continue;
            streams.push({ title: `${st.name || 'Unknown'} - ${q.title || 'Quality'}`, url: q.url, behaviorHints: { notWebReady: true } });
          }
        } else {
          streams.push({ title: st.name || 'Unknown', url: st.stream, behaviorHints: { notWebReady: true } });
        }
      } catch (e) {
        console.error('Stream entry build error', e);
      }
    }
    return { streams };
  } catch (err) {
    console.error('defineStreamHandler caught', err);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();
