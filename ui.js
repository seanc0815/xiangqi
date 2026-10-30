/* ui.js — 棋盤小館 手機版面（2026-10-30，Gabi：「其他棋類的介面好像沒有優化」）
   跟象棋一樣：窄螢幕（≤ 900px）時
     1. 輪到誰／分數 放到棋盤上面
     2. 新局、悔棋、認輸…這排按鈕緊貼在棋盤下面（不用再往下捲找）
     3. 玩法、規則、電腦強度這些設定收進「設定」一行：還沒開始下時打開，下了第一步就自動收起來（自己打開就不再自動收）
     4. 頁首的說明文字藏起來，棋盤往上移
   只搬 DOM 位置，不改各棋的程式（它們都用 id 找元素）；螢幕變寬（平板轉橫）就全部搬回原位。 */
(function () {
  const wrap = document.querySelector(".wrap"), panel = document.querySelector("aside.panel");
  if (!wrap || !panel) return;
  const board = panel.previousElementSibling;                       // 棋盤那一欄（圍棋是 .boardcol，其他是 .stage）
  if (!board || board === wrap.firstElementChild) return;

  const css = document.createElement("style");
  css.textContent = `
  .m-top, .m-bot { display: grid; gap: 8px; min-width: 0; }
  .m-top .status { min-height: 44px; }
  .m-top .score { margin: 0; }
  details.m-setup summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; list-style: none; }
  details.m-setup summary::-webkit-details-marker { display: none; }
  details.m-setup summary::before { content: "▸"; color: var(--muted); font-size: 12px; }
  details.m-setup[open] summary::before { content: "▾"; }
  details.m-setup summary .sum { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  details.m-setup[open] summary .sum { display: none; }
  details.m-setup > .group { margin-top: 12px; }
  body.m-lay .wrap { gap: 12px; }
  @media (max-width: 600px) { body.m-lay header.top p { display: none; } body.m-lay header.top h1 { font-size: 30px; } }`;
  document.head.appendChild(css);

  const mq = matchMedia("(max-width: 900px)");
  const top = document.createElement("div"); top.className = "m-top";
  const bot = document.createElement("div"); bot.className = "m-bot";
  const setup = document.createElement("details"); setup.className = "m-setup"; setup.open = true;
  setup.innerHTML = `<summary><span class="label">設定</span><span class="sum"></span></summary>`;
  const moved = [];                                                // [元素, 原位的記號]
  const mark = el => { const c = document.createComment("m"); el.parentNode.insertBefore(c, el); moved.push([el, c]); return el; };

  // 要搬的東西
  const pick = sel => [...panel.children].filter(el => el.matches(sel));
  const topEls = pick(".status, .score");
  const botEls = pick(".actions, .confirm, .scorebox, .group").filter(el => !el.matches(".group") || /吃掉/.test(el.textContent.slice(0, 20)))
    .sort((a, b) => a.matches(".group") - b.matches(".group"));   // 暗棋「被吃掉的子」也貼著棋盤
  const setEls = pick(".group").filter(el => el.id !== "netBox" && el.querySelector(".seg"));   // 有選項按鈕的才是設定（棋譜、被吃掉的子不算）

  let on = false;
  function apply() {
    if (mq.matches === on) return;
    on = mq.matches;
    document.body.classList.toggle("m-lay", on);
    if (on) {
      topEls.forEach(el => top.appendChild(mark(el)));
      botEls.forEach(el => bot.appendChild(mark(el)));
      if (setEls.length) {
        panel.insertBefore(setup, setEls[0]);
        setEls.forEach(el => setup.appendChild(mark(el)));
        const nb = document.getElementById("netBox");              // 連線的房間資訊放在設定外面：收起來也看得到
        if (nb && nb.parentNode === panel) panel.insertBefore(setup, nb);
      }
      wrap.insertBefore(top, board);
      wrap.insertBefore(bot, board.nextSibling);
    } else {
      for (const [el, c] of moved.splice(0)) { c.parentNode.insertBefore(el, c); c.remove(); }
      top.remove(); bot.remove(); setup.remove();
    }
  }
  apply();
  mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply);

  // 設定的摘要（收起來時顯示選了什麼）＋ 下了第一步自動收起
  let userTouched = false, lastN = -1;
  setup.querySelector("summary").addEventListener("click", () => { userTouched = true; });
  function tick() {
    const picks = setEls.filter(el => !el.hidden)
      .map(el => [...el.querySelectorAll('.seg button[aria-pressed="true"]')].map(b => b.textContent.trim()).join("・"))
      .filter(Boolean);
    setup.querySelector(".sum").textContent = picks.join("・");
    let n = 0;
    try { n = (typeof S !== "undefined" && S && Array.isArray(S.moves)) ? S.moves.length : 0; } catch (e) { }
    if (n !== lastN) {
      if (!userTouched && on) {
        if (lastN <= 0 && n > 0) setup.open = false;                // 開始下了：收起來
        else if (n === 0 && lastN > 0) setup.open = true;          // 新局：打開
      }
      if (n === 0) userTouched = false;
      lastN = n;
    }
  }
  tick();
  setInterval(tick, 400);
})();
