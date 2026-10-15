// 離線快取（build_pages.py 產生，不要手改）
const V = "xiangqi-3af6c5419a";
const CORE = ["./", "index.html", "manifest.json", "icon.png", "xiangqi.html", "go.html", "darkchess.html", "gomoku.html", "chess.html", "othello.html", "checkers.html", "ooxx.html", "connect4.html", "net.js"];
const FONT = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V && k !== "fonts").map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = req.url;
  if (FONT.test(url)) {                         // 字型：先用存的，沒有才抓並存起來
    e.respondWith(caches.open("fonts").then(c => c.match(req).then(hit => hit || fetch(req).then(r => {
      if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
      return r;
    }))));
    return;
  }
  if (new URL(url).origin !== self.location.origin) return;
  // 自己的檔案：先試網路（3 秒），失敗就用快取；成功就順便更新快取
  e.respondWith(Promise.race([fetch(req), timeout(3000)]).then(r => {
    if (r && r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
