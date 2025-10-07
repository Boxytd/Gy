#!/usr/bin/env node
"use strict";

const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon").default;

// Create handler returning a function for Vercel.
const handler = serveHTTP(addonInterface, { port: null });

// Per-request hard timeout (milliseconds). Vercel's default is around 10s for serverless, but we set safe bound.
const HARD_TIMEOUT_MS = 24000; // 24s

module.exports = (req, res) => {
  let finished = false;

  // Ensure the response ends exactly once.
  const safeEnd = (statusCode = 500, data = 'Internal Server Error') => {
    if (finished) return;
    finished = true;
    try {
      res.statusCode = statusCode;
      if (typeof data === 'string') res.end(data);
      else res.end(JSON.stringify(data));
    } catch (e) {
      try { res.end(); } catch (e2) { }
    }
  };

  // Hard timeout: if handler doesn't finish, return 504 quickly.
  const timer = setTimeout(() => {
    console.error('HARD TIMEOUT exceeded for request', req.url);
    safeEnd(504, 'Gateway Timeout');
  }, HARD_TIMEOUT_MS);

  try {
    // Call the stremio handler
    handler(req, res);

    // Hook into finish events to clear the timer
    res.on && res.on('finish', () => {
      clearTimeout(timer);
      finished = true;
    });
    res.on && res.on('close', () => {
      clearTimeout(timer);
      finished = true;
    });
  } catch (err) {
    console.error('Handler crash:', err);
    clearTimeout(timer);
    safeEnd(500, 'Internal Server Error');
  }
};
