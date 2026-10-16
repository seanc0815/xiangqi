/* net.js — 棋盤小館 連線對戰（2026-10-13，Gabi：「第一種 全部能連線的都做」）
   兩支手機直接連線（WebRTC）。PeerJS 公用伺服器只負責「牽線」（讓兩邊找到對方），棋步直接在兩支手機之間傳。
   一個房間＝開房那一方（host）的 PeerJS 編號 bbx26-<棋種>-<房號>；host 保管正本，對方（guest）收副本。
   共用狀態 doc：{ moves, over, cfg, hostSeat, req }；任何一方改動 → host 合併、版本 +1、整份送給對方。
   斷線：每 4 秒互相 ping，15 秒沒回應算斷線；guest 自動重連；任何一方重新整理網頁都會用 localStorage 接回同一盤。
   用法（每個棋）：
     const net = NetPlay.widget({ game, el, sides:["先手名稱","後手名稱"], adapter:{
       getState()            → {moves, over, cfg}            目前的棋局
       setState(st, remote)  ← 套用（remote＝對方送來的）
       turnSeat()            → 0／1                          輪到哪一方（0＝先手）
       undoFor(seat)         → moves                         悔棋到「seat 上一次輪到」為止的棋步
       newCfg()              → cfg（暗棋要重新洗牌）
       resignOver(seat)      → over                          seat 認輸後的結果
       drawOver()            → over（選配：西洋棋、象棋）
       onEnter(seat) / onLeave()                              進出房間（切換 S.mode、翻轉棋盤等）
     }});
     net.active()／net.mySeat()／net.myTurn()／net.connected()
     net.push()                         本地走完一步後呼叫（把 getState() 送出去）
     net.request("undo"|"new"|"draw")   需要對方同意的動作
     net.resign()                       認輸（直接生效）                                                  */
(function () {
  const LIB = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const PREFIX = "bbx26-";
  let libP = null;
  function loadLib() {
    if (window.Peer) return Promise.resolve();
    if (!libP) libP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LIB; s.async = true;
      s.onload = () => res(); s.onerror = () => { libP = null; rej(new Error("lib")); };
      document.head.appendChild(s);
    });
    return libP;
  }
  // 預熱（2026-10-17，Gabi：「加入的時候會有延遲」）：一切到連線對戰就先載入程式庫、向連線伺服器登記一個訪客身分，
  // 按「加入」時直接拿來用，省掉這兩步的等待。房主還是開房時才登記（要用房號當身分）。
  let warmPeer = null;
  function warm() {
    loadLib().then(() => {
      if (warmPeer && !warmPeer.destroyed && !warmPeer.disconnected) return;
      try { warmPeer = new window.Peer({ debug: 0 }); warmPeer.on("error", () => { }); } catch (e) { warmPeer = null; }
    }).catch(() => { });
  }
  function takeWarm() { const p = warmPeer; warmPeer = null; return p && !p.destroyed && !p.disconnected ? p : null; }
  const newCode = () => Array.from({ length: 4 }, () => CHARS[(Math.random() * CHARS.length) | 0]).join("");
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } },
  };
  // 房間存檔用 sessionStorage：每個分頁各自一份（重新整理還在；關掉分頁就沒了；另一個分頁看不到）。
  // 2026-10-17 之前用 localStorage，同一台裝置開兩個分頁會互相覆蓋、一邊離開會把另一邊的存檔也刪掉。
  const ss = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { } },
  };

  /* ───── 房間（只管傳輸與同步） ───── */
  class Room {
    // 2026-10-16（Gabi：「連線超級卡 會一直回朔」）：
    //  1. 訪客送出的每一步都有編號，主機回傳「收到第幾號」；沒收到回條的會留著，重新連上後補送（主機用編號去重）→ 斷線時下的那步不會消失
    //  2. 主機的棋局到了以後，再把自己還沒被確認的步數疊上去 → 畫面不會先退回去再跳回來
    //  3. 重新連線只有一條：以前逾時、斷線、伺服器重連會各自開一條，連線互相踢掉、一直重連
    constructor(game, code, role, h) {
      Object.assign(this, {
        game, code, role, h, doc: { v: 0, data: null }, peer: null, conn: null, closed: false, last: 0, timer: null,
        gid: Math.random().toString(36).slice(2, 10), seq: 0, pending: [], seen: { g: null, s: 0 }, retryT: null, busy: null, fails: 0,
      });
      this.onVis = () => {
        if (document.visibilityState !== "visible" || this.closed || this.role !== "guest" || (this.conn && this.conn.open)) return;
        clearTimeout(this.retryT); this.retryT = null;
        this.connectGuest(false).catch(() => { });
      };
      try { document.addEventListener("visibilitychange", this.onVis); } catch (e) { }
    }
    pid() { return PREFIX + this.game + "-" + this.code; }
    key() { return "bbx-room-" + this.game; }
    persist() { ss.set(this.key(), { code: this.code, role: this.role, doc: this.doc, gid: this.gid, seq: this.seq, pending: this.pending, seen: this.seen, tab: tabId() }); }
    restore(s) {
      this.doc = s.doc || { v: 0, data: null };
      if (s.gid) this.gid = s.gid;
      this.seq = s.seq || 0;
      this.pending = Array.isArray(s.pending) ? s.pending : [];
      this.seen = s.seen || { g: null, s: 0 };
      return this;
    }
    status(s, msg) { this.state = s; this.h.onStatus && this.h.onStatus(s, msg || ""); }
    send(o, c) { c = c || this.conn; try { if (c && c.open) c.send(o); } catch (e) { } }
    docMsg() { return { t: "doc", v: this.doc.v, data: this.doc.data, ack: this.seen }; }
    fire(remote) { this.persist(); this.h.onDoc && this.h.onDoc(this.doc.data, remote); }
    startPing() {
      clearInterval(this.timer);
      this.last = Date.now();
      this.timer = setInterval(() => {
        if (this.closed) return;
        this.send({ t: "ping" });
        const c = this.conn;
        if (c && c.open && Date.now() - this.last > 15000) {
          this.onConnLost(c);
          try { c.close(); } catch (e) { }
        }
      }, 4000);
    }
    onData(m, c) {
      this.last = Date.now();
      if (!m || typeof m !== "object") return;
      if (m.t === "ping") { this.send({ t: "pong" }, c); return; }
      if (m.t === "pong") return;
      if (this.role === "host") {
        if (m.t === "patch") {
          if (m.g !== this.seen.g) this.seen = { g: m.g || null, s: 0 };        // 換了一個訪客（或舊版沒有編號）
          if (!(m.s <= this.seen.s)) {                                        // 沒套用過的才套
            this.doc.data = Object.assign({}, this.doc.data, m.patch);
            this.doc.v++;
            this.seen = { g: this.seen.g, s: m.s || 0 };
            this.fire(true);
          }
          this.send(this.docMsg(), c);
        } else if (m.t === "hello") this.send(this.docMsg(), c);
      } else if (m.t === "handoff") { this.takeOver(m); return; }
      else if (m.t === "doc") {
        if (!(m.v >= this.doc.v)) return;
        const ack = m.ack;
        if (!ack) this.pending = [];                                          // 舊版主機不回條：不疊
        else if (ack.g === this.gid) this.pending = this.pending.filter(p => p.s > ack.s);
        let data = m.data;
        for (const p of this.pending) data = Object.assign({}, data, p.patch);
        const before = JSON.stringify(this.doc.data);
        this.doc = { v: m.v, data };
        if (JSON.stringify(data) !== before) this.fire(true); else this.persist();
      }
    }
    attach(conn) {
      conn.on("data", d => this.onData(d, conn));
      conn.on("open", () => {
        if (this.closed) { try { conn.close(); } catch (e) { } return; }
        const old = this.conn;
        this.conn = conn;
        if (old && old !== conn) { try { old.close(); } catch (e) { } }
        this.last = Date.now(); this.fails = 0;
        this.status("connected");
        if (this.role === "guest") {
          this.send({ t: "hello" });
          for (const p of this.pending) this.send({ t: "patch", g: this.gid, s: p.s, patch: p.patch });   // 補送斷線時下的
        } else this.send(this.docMsg());
      });
      conn.on("close", () => this.onConnLost(conn));
      conn.on("error", () => this.onConnLost(conn));
      if (!this.timer) this.startPing();
    }
    onConnLost(c) {
      if (this.closed || (c && this.conn !== c)) return;                     // 舊的連線關掉不算
      this.conn = null;
      if (this.role === "host") this.status("waiting", "對方離線了，等他重新連上…");
      else { this.status("reconnecting", "連線中斷，重新連線中…"); this.retry(1500); }
    }
    retry(ms) {
      if (this.closed || this.retryT) return;
      this.retryT = setTimeout(() => { this.retryT = null; this.connectGuest(false).catch(() => { }); }, ms);
    }
    async startHost(initial, fresh) {
      await loadLib();
      if (initial) { this.doc = { v: 1, data: initial }; this.persist(); }
      return new Promise((resolve, reject) => {
        const open = () => {
          if (this.closed) return;
          const p = new window.Peer(this.pid(), { debug: 0 });
          this.peer = p;
          p.on("open", () => { this.status(this.conn ? "connected" : "waiting", "等對方加入…"); resolve(this); });
          p.on("connection", c => this.attach(c));
          p.on("disconnected", () => { if (!this.closed && !p.destroyed) setTimeout(() => { try { if (p.disconnected && !p.destroyed) p.reconnect(); } catch (e) { } }, 2000); });
          p.on("error", e => {
            if (e && e.type === "unavailable-id") {
              try { p.destroy(); } catch (x) { }
              if (fresh) { this.code = newCode(); open(); }                 // 新房號撞到 → 換一個
              else setTimeout(open, 4000);                                  // 重新整理：舊編號還沒釋放，等一下
            } else if (e && (e.type === "network" || e.type === "server-error" || e.type === "socket-error" || e.type === "socket-closed")) {
              this.status(this.conn && this.conn.open ? "connected" : "error", "連不到連線伺服器，檢查一下網路");
              if (this.peer === p) setTimeout(() => { try { if (p.disconnected && !p.destroyed) p.reconnect(); } catch (x) { } }, 4000);
              reject && reject(e); reject = null;
            }
          });
        };
        open();
      });
    }
    connectGuest(first) {
      if (this.closed) return Promise.resolve(this);
      if (this.conn && this.conn.open) return Promise.resolve(this);
      if (this.busy) return this.busy;                                        // 已經在連了，不再開第二條
      this.status(first ? "connecting" : "reconnecting", first ? "連線中…" : "重新連線中…");
      this.busy = loadLib().then(() => new Promise((resolve, reject) => {
        let done = false, c = null;
        const finish = ok => {
          if (done) return;
          done = true; this.busy = null; this.onPeerErr = null;
          if (ok) { resolve(this); return; }
          if (c) { if (this.conn === c) this.conn = null; try { c.close(); } catch (e) { } }   // 放棄的連線關掉，免得晚點才接上把好的踢掉
          if (++this.fails >= 3 && this.peer) { try { this.peer.destroy(); } catch (e) { } this.peer = null; this.fails = 0; }
          if (first) reject(new Error("notfound"));
          else { this.status("reconnecting", "重新連線中…"); this.retry(3000); resolve(this); }
        };
        if (!this.peer || this.peer.destroyed) {
          const p = this.peer = takeWarm() || new window.Peer({ debug: 0 });
          p.on("error", e => { if (e && e.type === "peer-unavailable" && this.onPeerErr) this.onPeerErr(); });
          p.on("disconnected", () => { if (!this.closed && !p.destroyed) setTimeout(() => { try { if (p.disconnected && !p.destroyed) p.reconnect(); } catch (x) { } }, 2000); });
        }
        this.onPeerErr = () => finish(false);
        const start = () => {
          if (done || this.closed) return;
          c = this.peer.connect(this.pid(), { reliable: true });
          this.attach(c);
          c.on("open", () => finish(true));
        };
        setTimeout(() => finish(!!(c && c.open)), 10000);
        if (this.peer.open) start(); else this.peer.once("open", start);
      }));
      return this.busy;
    }
    update(patch) {
      this.doc.data = Object.assign({}, this.doc.data, patch);
      if (this.role === "host") { this.doc.v++; this.send(this.docMsg()); }
      else {
        const p = { s: ++this.seq, patch };
        this.pending.push(p);
        this.send({ t: "patch", g: this.gid, s: p.s, patch });
      }
      this.fire(false);
    }
    shut() {
      this.closed = true; clearInterval(this.timer); clearTimeout(this.retryT);
      try { document.removeEventListener("visibilitychange", this.onVis); } catch (e) { }
      try { this.conn && this.conn.close(); } catch (e) { }
      try { this.peer && this.peer.destroy(); } catch (e) { }
    }
    dispose() { this.shut(); }       // 只關連線，不清掉存檔（試探房間失敗時用）
    close() { this.shut(); ss.del(this.key()); }
    // 離開房間（2026-10-17，Gabi：「離開後房間就要刪掉，除非裡面有人」）
    // 對手還連著 → 把整份棋局交給他，他變成主機、房號不變；沒人 → 直接關，房號失效。存檔一律清掉，不會自動接回。
    leave() {
      if (this.closed) return;
      const c = this.conn, live = !!(c && c.open);
      if (live && this.role === "host") this.send({ t: "handoff", v: this.doc.v, data: this.doc.data }, c);
      this.conn = null;
      if (live) setTimeout(() => this.close(), 200); else this.close();     // 讓最後的訊息送出去
    }
    takeOver(m) {                    // 訪客收到主機交棒：接手當主機
      if (this.role !== "guest" || this.closed) return;
      const data = Object.assign({}, m.data || this.doc.data);
      if (typeof data.hostSeat === "number") data.hostSeat = 1 - data.hostSeat;   // 共用元件的座位是「主機是哪一邊」→ 翻過來才不會換位子
      this.doc = { v: (m.v || this.doc.v) + 1, data }; this.pending = []; this.seen = { g: null, s: 0 };
      clearTimeout(this.retryT); this.retryT = null; this.busy = null;
      const c = this.conn; this.conn = null; try { c && c.close(); } catch (e) { }
      try { this.peer && this.peer.destroy(); } catch (e) { } this.peer = null;
      this.role = "host"; this.persist();
      this.status("waiting", "對方離開了，房間交給你；把房號給新對手就能繼續");
      setTimeout(() => { if (!this.closed) this.startHost(null, false).catch(() => { }); }, 500);
      this.fire(true);
    }
  }

  /* ───── 每個棋共用的介面（大廳、房間、請求確認） ───── */
  function widget(o) {
    const A = o.adapter, el = o.el;
    let room = null, seat = null, lastReqSeen = null, swapNote = "";
    el.innerHTML = `
      <div data-n="lobby">
        <div class="group"><span class="label">我要當</span>
          <div class="seg" data-n="seatSeg"><button data-s="0" aria-pressed="true">${o.sides[0]}</button><button data-s="1" aria-pressed="false">${o.sides[1]}</button></div></div>
        <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
          <button class="btn primary" data-n="create">開新房間</button><span class="note">開好後把房號或邀請連結傳給對手</span></div>
        <div class="row" style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input data-n="code" maxlength="4" placeholder="房號" autocomplete="off" aria-label="輸入房號"
            style="flex:1;min-width:0;font:inherit;font-size:18px;letter-spacing:.3em;text-transform:uppercase;text-align:center;padding:7px 8px;border-radius:9px;border:1px solid var(--rule);background:var(--ground);color:var(--ink)">
          <button class="btn" data-n="join">加入</button></div>
        <div class="note" data-n="lnote" style="margin-top:8px"></div>
      </div>
      <div data-n="inroom" hidden>
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span class="label">房號</span>
          <span data-n="rcode" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:.25em;user-select:all">----</span>
          <button class="btn" data-n="copy" style="padding:4px 10px;font-size:13px">複製邀請連結</button></div>
        <div data-n="who" style="font-size:13px;margin-top:4px"></div>
        <div class="note" data-n="rnote" style="margin-top:4px"></div>
        <div data-n="ask" hidden style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:13px">
          <span data-n="asktext"></span><button class="btn primary" data-n="yes" style="padding:4px 10px;font-size:13px">同意</button><button class="btn" data-n="no" style="padding:4px 10px;font-size:13px">不同意</button></div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-n="swap" style="padding:4px 10px;font-size:13px">交換</button><button class="btn" data-n="leave" style="padding:4px 10px;font-size:13px">離開房間</button></div>
      </div>`;
    const $ = n => el.querySelector(`[data-n="${n}"]`);
    let wantSeat = 0;
    el.querySelectorAll('[data-n="seatSeg"] button').forEach(b => b.onclick = () => {
      wantSeat = +b.dataset.s;
      el.querySelectorAll('[data-n="seatSeg"] button').forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.s === wantSeat)));
    });
    const handlers = {
      onStatus(s, msg) { render(msg); },
      onDoc(d, remote) {
        if (!d) return;
        let note;
        if (room) {
          const s = room.role === "host" ? d.hostSeat : 1 - d.hostSeat;
          if (seat !== null && s !== seat) {               // 有人按了「交換」：兩邊都換位子、清空棋盤
            seat = s; A.onEnter && A.onEnter(seat);
            A.setState({ moves: d.moves || [], over: d.over || null, cfg: d.cfg || null }, true);
            note = swapNote = `已交換：你現在是${o.sides[seat]}`;
          } else if (seat === null) seat = s;
        }
        if (remote) A.setState({ moves: d.moves || [], over: d.over || null, cfg: d.cfg || null }, true);
        render(note);
      },
    };
    function enter(r) {
      room = r;
      seat = r.doc.data ? (r.role === "host" ? r.doc.data.hostSeat : 1 - r.doc.data.hostSeat) : null;
      A.onEnter && A.onEnter(seat);
      if (r.doc.data) A.setState({ moves: r.doc.data.moves || [], over: r.doc.data.over || null, cfg: r.doc.data.cfg || null }, true);
      render();
    }
    async function create() {
      $("create").disabled = true; $("lnote").textContent = "開房間中…";
      const st = A.getState();
      const r = new Room(o.game, newCode(), "host", handlers);
      try {
        await r.startHost({ moves: [], over: null, cfg: A.newCfg ? A.newCfg() : st.cfg, hostSeat: wantSeat, req: null }, true);
        enter(r); $("lnote").textContent = "";
      } catch (e) { $("lnote").textContent = "開房間失敗：連不到連線伺服器，檢查網路後再試一次。"; r.close(); }
      $("create").disabled = false;
    }
    async function join(codeIn) {
      const code = (codeIn || $("code").value).trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { $("lnote").textContent = "房號是 4 個英文字母或數字。"; return; }
      $("join").disabled = true; $("lnote").textContent = `連線到房間 ${code}…`;
      const r = new Room(o.game, code, "guest", handlers);
      try {
        await r.connectGuest(true);
        // 等第一份棋局
        for (let k = 0; k < 120 && !r.doc.data; k++) await new Promise(res => setTimeout(res, 50));
        if (!r.doc.data) throw new Error("nodoc");
        enter(r); $("lnote").textContent = "";
      } catch (e) {
        r.close();
        $("lnote").textContent = `連不到房間 ${code}：確認房號，或請對方保持網頁開著。（少數網路環境，例如某些行動網路，兩支手機沒辦法直接連線）`;
      }
      $("join").disabled = false;
    }
    function leave(silent) {
      if (room) room.leave();
      room = null; seat = null; lastReqSeen = null; swapNote = "";
      A.onLeave && A.onLeave();
      if (!silent) render();
    }
    function render(msg) {
      const inRoom = !!room;
      $("lobby").hidden = inRoom; $("inroom").hidden = !inRoom;
      if (!inRoom) return;
      $("rcode").textContent = room.code;
      const d = room.doc.data || {};
      const st = room.state;
      const other = seat === null ? "" : o.sides[1 - seat];
      $("who").textContent = seat === null ? "" : `你：${o.sides[seat]}｜對手：${other}`;
      if (d.moves && d.moves.length) swapNote = "";
      $("rnote").textContent = msg || (st === "connected" && swapNote ? swapNote : st === "connected" ? "已連線" : st === "waiting" ? (room.role === "host" ? "等對方加入（對方輸入房號或點邀請連結）" : "") : st === "reconnecting" ? "重新連線中…" : st === "error" ? "連線伺服器連不上，檢查網路" : "連線中…");
      const req = d.req;
      const ask = $("ask");
      const sw = $("swap"), fresh = !(d.moves && d.moves.length) || !!d.over;
      sw.textContent = seat === null ? "交換" : `換我當${o.sides[1 - seat]}`;
      sw.disabled = seat === null || !fresh;
      sw.title = fresh ? "" : "下完這盤（或還沒開始時）才能交換";
      if (req && req.by !== seat && (!d.over || req.type === "new")) {      // 結束後只剩「重開一盤」有意義
        ask.hidden = false;
        $("asktext").textContent = { undo: "對方想悔棋，同意嗎？", new: "對方想重新開一盤，同意嗎？", draw: "對方提和，同意嗎？" }[req.type] || "對方的請求";
      } else ask.hidden = true;
      if (req && req.by === seat) $("rnote").textContent = { undo: "等對方同意悔棋…", new: "等對方同意重開…", draw: "等對方回覆求和…" }[req.type];
      if (d.reqNote && d.reqNote.to === seat && lastReqSeen !== d.reqNote.id) { lastReqSeen = d.reqNote.id; $("rnote").textContent = d.reqNote.text; }
      o.onRender && o.onRender();
    }
    $("create").onclick = create;
    $("join").onclick = () => join();
    $("leave").onclick = () => leave();
    $("swap").onclick = () => {                            // 還沒開始或下完一盤時，換邊並重開（不用對方同意，對方畫面會提示）
      const d = room && room.doc.data; if (!d || seat === null) return;
      if (d.moves && d.moves.length && !d.over) return;
      room.update({ hostSeat: 1 - d.hostSeat, moves: [], over: null, req: null, cfg: d.over && A.newCfg ? A.newCfg() : d.cfg });
    };
    $("copy").onclick = () => {
      const u = new URL(location.href); u.searchParams.set("room", room.code);
      const txt = u.toString();
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
        () => { $("rnote").textContent = "邀請連結已複製，貼給對手就好"; },
        () => { $("rnote").textContent = txt; });
    };
    $("yes").onclick = () => {
      const d = room.doc.data, req = d.req; if (!req) return;
      let patch = { req: null };
      if (req.type === "undo") patch.moves = A.undoFor(req.by);
      if (req.type === "new") Object.assign(patch, { moves: [], over: null, cfg: A.newCfg ? A.newCfg() : d.cfg });
      if (req.type === "draw" && A.drawOver) patch.over = A.drawOver();
      A.setState({ moves: patch.moves || d.moves, over: "over" in patch ? patch.over : d.over, cfg: patch.cfg || d.cfg }, true);
      room.update(patch);
    };
    $("no").onclick = () => {
      const req = room.doc.data.req; if (!req) return;
      room.update({ req: null, reqNote: { to: req.by, id: Date.now(), text: { undo: "對方不同意悔棋", new: "對方不同意重開", draw: "對方拒絕和棋" }[req.type] } });
    };
    // 重新整理後接回同一盤；或網址帶 ?room=XXXX 自動加入
    const saved = ss.get("bbx-room-" + o.game);
    const urlRoom = new URLSearchParams(location.search).get("room");
    setTimeout(async () => {
      if (urlRoom && (!saved || saved.code !== urlRoom.toUpperCase())) {
        o.onWantOnline && o.onWantOnline();
        try { history.replaceState(null, "", location.pathname); } catch (e) { }
        join(urlRoom);
      } else if (saved && saved.code) {
        o.onWantOnline && o.onWantOnline();
        const r = new Room(o.game, saved.code, saved.role, handlers).restore(saved);
        enter(r);
        if (saved.role === "host") r.startHost(null, false).catch(() => { });
        else r.connectGuest(false).catch(() => { });
      }
    }, 50);
    return {
      active: () => !!room,
      mySeat: () => seat,
      connected: () => !!room && room.state === "connected",
      myTurn: () => !!room && room.state === "connected" && !(room.doc.data && room.doc.data.over) && A.turnSeat() === seat,
      push() { if (!room) return; const s = A.getState(); room.update({ moves: s.moves, over: s.over || null, cfg: s.cfg || (room.doc.data && room.doc.data.cfg) || null }); },
      request(type) { if (!room || !room.doc.data) return; room.update({ req: { type, by: seat, n: (room.doc.data.moves || []).length, id: Date.now() } }); },
      resign() { if (!room) return; const over = A.resignOver(seat); A.setState({ moves: room.doc.data.moves || [], over, cfg: room.doc.data.cfg }, false); room.update({ over, req: null }); },
      leave: () => leave(true),
      render: () => render(),
    };
  }
  /* ───── 給象棋用：跟 claude.ai 共用資料庫一樣的介面（doc().get/set/update/onSnapshot），底下換成點對點 ─────
     象棋原本的連線程式完全照舊；不在 claude.ai 上時把 NET.db 換成這個。                                         */
  // 每個分頁一個識別碼（2026-10-17）：同一個瀏覽器開兩個分頁算兩個人；重新整理同一個分頁還是同一個人。
  // 以前整個瀏覽器共用一個，自己開房再從另一個分頁加入會被當成「房主回來」→ 兩邊都是紅、或找不到房間。
  function tabId() {
    let t = null;
    try { t = sessionStorage.getItem("bbx-tab"); if (!t) { t = Math.random().toString(36).slice(2, 8); sessionStorage.setItem("bbx-tab", t); } } catch (e) { t = "x"; }
    return t;
  }
  function me() {
    let v = ls.get("bbx-me");
    if (!v) { v = Math.random().toString(36).slice(2, 10); ls.set("bbx-me", v); }
    return v + "-" + tabId();
  }
  function db(game) {
    const rooms = {};                 // code → Room
    const subs = {};                  // code → Set(callback)
    const snap = r => ({ exists: !!(r && r.doc.data), data: () => r && r.doc.data });
    const handlersFor = code => ({
      onStatus() { },
      onDoc() { (subs[code] || new Set()).forEach(cb => { try { cb(snap(rooms[code])); } catch (e) { } }); },
    });
    async function ensure(code) {
      if (rooms[code]) return rooms[code];
      const saved = ss.get("bbx-room-" + game);
      if (saved && saved.code === code) {   // 重新整理：接回原本的角色（只限原本那個分頁）
        const r = new Room(game, code, saved.role, handlersFor(code)).restore(saved);
        rooms[code] = r;
        if (saved.role === "host") r.startHost(null, false).catch(() => { }); else r.connectGuest(false).catch(() => { });
        return r;
      }
      let r = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {                     // 連線伺服器偶爾會漏接：失敗再試一次
        const t = new Room(game, code, "guest", handlersFor(code));
        try { await t.connectGuest(true); } catch (e) { t.dispose(); continue; }
        for (let k = 0; k < 150 && !t.doc.data; k++) await new Promise(res => setTimeout(res, 50));
        if (t.doc.data) r = t; else t.dispose();
      }
      if (!r) throw new Error("notfound");                                       // 找不到房間
      rooms[code] = r;
      return r;
    }
    return {
      doc(path) {
        const code = String(path).split("/").pop();
        return {
          async get() {
            try { return snap(await ensure(code)); } catch (e) { return { exists: false, data: () => null }; }
          },
          async set(data) {
            if (rooms[code]) rooms[code].close();
            const r = new Room(game, code, "host", handlersFor(code));
            rooms[code] = r;
            await r.startHost(data, false);
          },
          async update(patch) {
            const r = rooms[code] || await ensure(code);
            r.update(patch);
          },
          onSnapshot(cb, err) {
            (subs[code] = subs[code] || new Set()).add(cb);
            ensure(code).then(r => cb(snap(r))).catch(e => err && err(e));
            return () => { subs[code] && subs[code].delete(cb); };
          },
        };
      },
      leave(code) { if (rooms[code]) { rooms[code].leave(); delete rooms[code]; } },
    };
  }
  // 其他棋：按「連線對戰」或點房號輸入框時預熱
  try {
    document.addEventListener("click", e => { if (e.target && e.target.closest && e.target.closest('[data-mode="online"]')) warm(); }, true);
    document.addEventListener("focusin", e => { if (e.target && e.target.matches && e.target.matches('[data-n="code"], #joinCode')) warm(); }, true);
  } catch (e) { }
  window.NetPlay = { widget, newCode, db, me, warm };
})();
