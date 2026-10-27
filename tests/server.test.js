import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppServer } from '../server.mjs';

async function withServer(run, options = {}) {
  const server = createAppServer({ cacheDirectory: null, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('server serves the app with restrictive security headers', () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await response.text(), /Steam 游戏陈列库/);
}));

test('cover proxy uses a fixed Steam destination and caches duplicate image requests', async () => {
  let calls = 0;
  await withServer(async (baseUrl) => {
    const responses = await Promise.all([fetch(`${baseUrl}/api/steam/covers/10?variant=2`), fetch(`${baseUrl}/api/steam/covers/10?variant=2`)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([255, 216, 255]));
    }
    assert.equal(calls, 1);
  }, { fetchCover: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg');
    assert.equal(options.redirect, 'error');
    return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
});

test('cover proxy rejects arbitrary sources and invalid variants before making a request', () => withServer(async (baseUrl) => {
  for (const path of ['abc', '10?variant=4', '10?variant=-1', '10?url=https://example.com', '10?variant=1x']) {
    assert.equal((await fetch(`${baseUrl}/api/steam/covers/${path}`)).status, 400);
  }
}, { fetchCover: () => { throw new Error('No external fetch expected'); } }));

test('cover proxy rejects non-raster content, redirects, and oversized image bodies', async () => {
  for (const fetchCover of [
    async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    async () => new Response('redirect', { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } }),
  ]) {
    await withServer(async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/steam/covers/10`)).status, 502);
    }, { fetchCover });
  }
});

test('server does not expose archives or tool files', () => withServer(async (baseUrl) => {
  assert.equal((await fetch(`${baseUrl}/data/archive/steam-library-2026-06-09.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/tools/legacy/check.py`)).status, 404);
}));

test('automatic covers resolve hashed artwork and share the cached image with palette requests', async () => {
  const artwork = 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/4064510/60fb8a75026cf12766973a335f00dc360b30b61b/header.jpg?t=1786543749';
  const calls = [];
  await withServer(async (baseUrl) => {
    const url = `${baseUrl}/api/steam/covers/4064510?variant=auto`;
    for (const response of await Promise.all([fetch(url), fetch(url)])) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([255, 216, 255]));
    }
    assert.equal((await fetch(url)).status, 200);
    assert.equal(calls.filter((url) => url.includes('/api/appdetails?')).length, 1);
    assert.equal(calls.filter((url) => url === artwork).length, 1, 'one resolved image download');
  }, { fetchCover: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://store.steampowered.com/api/appdetails?')) {
      return Response.json({ 4064510: { success: true, data: { header_image: artwork } } });
    }
    if (url !== artwork) return new Response('', { status: 404 });
    return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
});

test('automatic covers keep old games working when metadata or official artwork is unavailable', async () => {
  for (const mode of ['api-failure', 'missing', 'image-failure', 'unsafe-url', 'wrong-app']) {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/steam/covers/10?variant=auto`);
      assert.equal(response.status, 200, mode);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([255, 216, 255]), mode);
    }, { fetchCover: async (url) => {
      if (url.startsWith('https://store.steampowered.com/api/appdetails?')) {
        if (mode === 'api-failure') throw new Error('offline');
        if (mode === 'missing') return Response.json({ 10: { success: false } });
        const header_image = mode === 'unsafe-url' ? 'http://127.0.0.1/private'
          : `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${mode === 'wrong-app' ? '20' : '10'}/abc/header.jpg`;
        return Response.json({ 10: { success: true, data: { header_image } } });
      }
      assert.ok(!url.includes('127.0.0.1') && !url.includes('/apps/20/'), 'untrusted destinations are never fetched');
      if (url.includes('/abc/')) return new Response('', { status: 404 });
      if (url === 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg') {
        return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('', { status: 404 });
    } });
  }
});

test('library endpoint rejects invalid credentials without a remote request', () => withServer(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/steam/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'bad', steamId: '123' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /API Key/);
}));
