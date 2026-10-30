// 離線快取（build_pages.py 產生，不要手改）
const V = "xiangqi-f976962a73";
const CORE = ["./", "index.html", "manifest.json", "icon.png", "xiangqi.html", "go.html", "darkchess.html", "gomoku.html", "chess.html", "othello.html", "checkers.html", "ooxx.html", "connect4.html", "quoridor.html", "fengtd.html", "net.js", "ui.js", "sfx/check.mp3", "sfx/mate.mp3", "sfx/mate_二鬼拍門.mp3", "sfx/mate_單兵殺.mp3", "sfx/mate_單炮殺.mp3", "sfx/mate_單車殺.mp3", "sfx/mate_單馬殺.mp3", "sfx/mate_大膽穿心.mp3", "sfx/mate_天地炮.mp3", "sfx/mate_夾車炮.mp3", "sfx/mate_對面笑.mp3", "sfx/mate_悶宮.mp3", "sfx/mate_悶殺.mp3", "sfx/mate_拔簧馬.mp3", "sfx/mate_掛角馬.mp3", "sfx/mate_海底撈月.mp3", "sfx/mate_炮兵殺.mp3", "sfx/mate_空頭炮.mp3", "sfx/mate_老兵搜山.mp3", "sfx/mate_臥槽馬.mp3", "sfx/mate_車兵殺.mp3", "sfx/mate_車炮殺.mp3", "sfx/mate_車馬殺.mp3", "sfx/mate_車馬炮殺.mp3", "sfx/mate_重炮.mp3", "sfx/mate_釣魚馬.mp3", "sfx/mate_鐵門栓.mp3", "sfx/mate_雙兵殺.mp3", "sfx/mate_雙炮.mp3", "sfx/mate_雙車殺.mp3", "sfx/mate_雙車錯.mp3", "sfx/mate_雙馬殺.mp3", "sfx/mate_雙馬飲泉.mp3", "sfx/mate_馬兵殺.mp3", "sfx/mate_馬後炮.mp3", "sfx/mate_馬炮殺.mp3", "sfx/mate_高釣馬.mp3", "sfx/wood_l0.mp3", "sfx/wood_l1.mp3", "sfx/wood_l2.mp3", "sfx/wood_l3.mp3", "sfx/wood_l4.mp3", "sfx/wood_m0.mp3", "sfx/wood_m1.mp3", "sfx/wood_m2.mp3", "sfx/wood_m3.mp3", "sfx/wood_m4.mp3"];
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
  // cache:"no-cache" → 一定向伺服器確認有沒有新版（2026-10-17：GitHub 的 10 分鐘快取讓手機一直拿到舊版）
  const fresh = req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" });
  e.respondWith(Promise.race([fresh, timeout(3000)]).then(r => {
    if (r && r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
