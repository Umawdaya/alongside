/* ─────────────────────────────────────────────
   全國社區心理衛生中心地圖　Service Worker
   《做伙行》
   ─────────────────────────────────────────────
   快取策略：
   · 主頁面 HTML → 網路優先，離線時回退快取（確保資料更新即時生效）
   · 程式庫與字型 → 快取優先（版本固定，不常變動）
   · 地圖圖磚     → 快取優先＋數量上限（看過的區域可離線瀏覽）

   本檔同時承擔兩項任務：
   1. PWA 離線快取（原有功能）
   2. OneSignal 推播通知處理（新整合）
   兩者共用同一個 Service Worker，互不影響。
   ───────────────────────────────────────────── */

// ── OneSignal 推播通知處理 ──
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const VERSION    = 'v1';
const CACHE_APP  = `cmhc-app-${VERSION}`;   // 頁面與圖示
const CACHE_LIB  = `cmhc-lib-${VERSION}`;   // Leaflet、字型
const CACHE_TILE = `cmhc-tile-${VERSION}`;  // 地圖圖磚
const TILE_LIMIT = 400;                     // 圖磚快取上限（約 10–20 MB）

// 安裝時預先快取的核心檔案
const CORE = [
  './',
  './cmhc-map.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── 安裝：預快取核心檔案 ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_APP)
      .then(c => c.addAll(CORE).catch(() => {
        // 個別檔案失敗不阻斷安裝
        return Promise.all(CORE.map(u => c.add(u).catch(() => null)));
      }))
      .then(() => self.skipWaiting())
  );
});

// ── 啟用：清除舊版快取 ──
self.addEventListener('activate', e => {
  const keep = [CACHE_APP, CACHE_LIB, CACHE_TILE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('cmhc-') && !keep.includes(k))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── 圖磚快取數量控制（超過上限刪除最舊的）──
async function trimTiles() {
  const cache = await caches.open(CACHE_TILE);
  const keys = await cache.keys();
  if (keys.length > TILE_LIMIT) {
    // 刪除最早存入的 1/4，避免頻繁修剪
    const n = Math.ceil(keys.length - TILE_LIMIT + TILE_LIMIT * 0.25);
    await Promise.all(keys.slice(0, n).map(k => cache.delete(k)));
  }
}

// ── 快取優先 ──
async function cacheFirst(req, cacheName, after) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      await cache.put(req, res.clone());
      if (after) after();
    }
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

// ── 網路優先 ──
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req) || await cache.match('./cmhc-map.html');
    if (hit) return hit;
    throw err;
  }
}

// ── 攔截請求 ──
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const host = url.hostname;

  // 地圖圖磚
  if (host.endsWith('basemaps.cartocdn.com') || host.endsWith('tile.openstreetmap.org')
      || host.endsWith('nlsc.gov.tw')) {
    e.respondWith(cacheFirst(req, CACHE_TILE, trimTiles));
    return;
  }

  // 程式庫與字型
  if (host === 'cdnjs.cloudflare.com' || host === 'unpkg.com'
      || host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, CACHE_LIB));
    return;
  }

  // 本站資源：導覽請求與同源檔案
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' || req.destination === 'document') {
      e.respondWith(networkFirst(req, CACHE_APP));
    } else {
      e.respondWith(cacheFirst(req, CACHE_APP));
    }
    return;
  }

  // 其他（如外部連結）不介入
});

// ── 接受頁面指令：立即套用新版 ──
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
