import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCoverProxy } from './services/cover-proxy.mjs';
import { createLibraryBackupStore } from './services/library-backup.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_BODY_BYTES = 16 * 1024;

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
});

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://cdn.cloudflare.steamstatic.com https://shared.cloudflare.steamstatic.com https://shared.akamai.steamstatic.com https://cdn.akamai.steamstatic.com",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload), {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function isAllowedStaticPath(pathname) {
  return pathname === '/index.html'
    || pathname === '/data/default-library.json'
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/src/');
}

async function serveStatic(pathname, response, method) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  if (!isAllowedStaticPath(requested)) {
    sendJson(response, 404, { error: '未找到资源' });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    sendJson(response, 400, { error: '路径格式无效' });
    return;
  }

  const filePath = path.resolve(ROOT, `.${decoded}`);
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(response, 403, { error: '禁止访问' });
    return;
  }

  try {
    const body = await readFile(filePath);
    send(response, 200, method === 'HEAD' ? '' : body, {
      'Cache-Control': 'no-cache',
      'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    });
  } catch (error) {
    sendJson(response, error.code === 'ENOENT' ? 404 : 500, {
      error: error.code === 'ENOENT' ? '未找到资源' : '无法读取资源',
    });
  }
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchSteamJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SteamLibraryLocal/4.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Steam API 返回 HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleSearch(url, response) {
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (query.length < 2 || query.length > 120) {
    sendJson(response, 400, { error: '搜索词长度需要在 2 到 120 个字符之间' });
    return;
  }
  const payload = await fetchSteamJson(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(query)}`);
  const results = Array.isArray(payload)
    ? payload.slice(0, 12).map((item) => ({ appid: String(item.appid ?? ''), name: String(item.name ?? '') }))
    : [];
  sendJson(response, 200, { results });
}

async function handleAppDetails(appId, response) {
  if (!/^\d{1,10}$/.test(appId)) {
    sendJson(response, 400, { error: 'App ID 格式无效' });
    return;
  }
  const endpoint = new URL('https://store.steampowered.com/api/appdetails');
  endpoint.searchParams.set('appids', appId);
  endpoint.searchParams.set('l', 'schinese');
  const payload = await fetchSteamJson(endpoint);
  const app = payload?.[appId];
  if (!app?.success || !app.data) {
    sendJson(response, 404, { error: 'Steam 未返回该游戏的信息' });
    return;
  }
  sendJson(response, 200, { app: app.data });
}

async function handleOwnedLibrary(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error instanceof RangeError ? 413 : 400, { error: error.message || 'JSON 格式无效' });
    return;
  }

  const apiKey = String(body?.apiKey ?? '').trim();
  const steamId = String(body?.steamId ?? '').trim();
  if (!/^[a-f\d]{32}$/i.test(apiKey)) {
    sendJson(response, 400, { error: 'Steam API Key 应为 32 位十六进制字符串' });
    return;
  }
  if (!/^\d{17}$/.test(steamId)) {
    sendJson(response, 400, { error: 'Steam ID 应为 17 位数字' });
    return;
  }

  const endpoint = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  endpoint.searchParams.set('key', apiKey);
  endpoint.searchParams.set('steamid', steamId);
  endpoint.searchParams.set('include_appinfo', 'true');
  endpoint.searchParams.set('include_played_free_games', 'true');
  endpoint.searchParams.set('format', 'json');
  const payload = await fetchSteamJson(endpoint);
  const games = payload?.response?.games;
  if (!Array.isArray(games)) {
    sendJson(response, 502, { error: 'Steam 没有返回游戏列表，请确认资料可见性与凭据' });
    return;
  }
  sendJson(response, 200, { games });
}

async function route(request, response, getCover, saveBackup) {
  const url = new URL(request.url, `http://${request.headers.host ?? `${HOST}:${DEFAULT_PORT}`}`);
  try {
    if (request.method === 'POST' && url.pathname === '/api/library/backups') {
      // A third-party page must not write to this local data directory.
      const origin = request.headers.origin;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || (origin && origin !== url.origin)
        || request.headers['sec-fetch-site'] === 'cross-site'
        || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        sendJson(response, 403, { error: '只允许当前页面保存备份' });
        return;
      }
      let payload;
      try { payload = await readJsonBody(request, 8 * 1024 * 1024); }
      catch (error) {
        sendJson(response, error instanceof RangeError ? 413 : 400, { error: '备份内容过大或格式无效' });
        return;
      }
      try {
        const result = await saveBackup(payload);
        getCover.prefetch(payload.games.map((game) => game.appId).filter(Boolean));
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error instanceof TypeError ? 400 : 500, { error: '无法保存本地备份' });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/steam/covers/')) {
      const appId = url.pathname.slice('/api/steam/covers/'.length);
      const variant = url.searchParams.get('variant') ?? '0';
      if (!/^\d{1,10}$/.test(appId) || !/^(?:auto|[0-3])$/.test(variant)
        || [...url.searchParams.keys()].some((key) => key !== 'variant')) {
        sendJson(response, 400, { error: '封面参数无效' });
        return;
      }
      const image = await getCover(appId, variant === 'auto' ? variant : Number(variant));
      send(response, 200, image.body, {
        'Content-Type': image.contentType,
        'Cache-Control': 'private, max-age=3600',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/steam/search') {
      await handleSearch(url, response);
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/steam/apps/')) {
      await handleAppDetails(url.pathname.slice('/api/steam/apps/'.length), response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/steam/library') {
      await handleOwnedLibrary(request, response);
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(url.pathname, response, request.method);
      return;
    }
    sendJson(response, 405, { error: '不支持该请求方法' });
  } catch (error) {
    const message = error.name === 'AbortError' ? '连接 Steam 超时' : 'Steam 服务暂时不可用';
    sendJson(response, 502, { error: message });
  }
}

export function createAppServer({ fetchCover, dataDirectory = path.join(ROOT, 'data'),
  cacheDirectory = path.join(dataDirectory, 'covers') } = {}) {
  const getCover = createCoverProxy(fetchCover, { cacheDirectory });
  const saveBackup = createLibraryBackupStore(path.join(dataDirectory, 'backups'));
  return createServer((request, response) => route(request, response, getCover, saveBackup));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const server = createAppServer();
  server.listen(port, HOST, () => {
    console.log(`Steam 游戏陈列库已启动：http://${HOST}:${port}`);
  });
}
