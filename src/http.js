// Minimal HTTP(S) GET with redirects and a timeout, on node:https so it runs on
// every Node.js lastgreen supports (global fetch only arrived in Node 18 and
// warns there as experimental).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

/** Resolves to the response stream of a 200; follows up to 5 redirects. */
export function get(url, { headers = {}, timeoutMs = 30_000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'lastgreen', ...headers } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects: ${url}`));
        const next = new URL(res.headers.location, url).toString();
        const forwarded = { ...headers };
        if (new URL(next).host !== new URL(url).host) delete forwarded.Authorization; // never leak tokens
        return resolve(get(next, { headers: forwarded, timeoutMs, redirects: redirects - 1 }));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status} for ${url}`));
      }
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${url}`)));
    req.on('error', reject);
  });
}

export async function getText(url, options) {
  const res = await get(url, options);
  res.setEncoding('utf8');
  let text = '';
  for await (const chunk of res) text += chunk;
  return text;
}

export async function getJson(url, options) {
  return JSON.parse(await getText(url, options));
}

/** Stream a URL to a file; `through` can observe chunks (hashing). */
export async function download(url, file, { timeoutMs = 120_000, through = [] } = {}) {
  const res = await get(url, { timeoutMs });
  await pipeline(res, ...through, fs.createWriteStream(file));
}
