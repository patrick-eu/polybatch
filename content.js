// content.js
(function () {
  // 面板文案：JS 内置双语字典（运行时可切换，chrome.i18n 做不到运行时切换）。
  const STRINGS = {
    en: { market:'MARKET', dir:'Direction', buyPerBin:'Buy per option', shares:'shares',
          loading:'Loading…', noBins:'No batchable options found', place:'Place orders',
          depth:'No depth', loadFail:'Load failed', spend:'Total spend',
          profit:'PROFITABLE', loss:'WILL LOSE', partial:'Some legs lack depth',
          noChecked:'No options selected', cantLocate:'Couldn’t locate order area — place manually:', legs:'legs', confirmTitle:'Confirm order', confirmBtn:'Confirm', cancelBtn:'Cancel', abortBtn:'Abort',
          legProgress:'Leg', awaitingSign:'Sign in MetaMask…', switching:'Switching…',
          filledMsg:'submitted', timeoutMsg:'not confirmed — continue / skip / abort',
          contBtn:'Continue', skipBtn:'Skip', allDone:'All legs submitted' },
    zh: { market:'市场', dir:'方向', buyPerBin:'每个选项买', shares:'份额',
          loading:'加载中…', noBins:'未识别到可批量的选项', place:'下单',
          depth:'无深度', loadFail:'加载失败', spend:'总花费',
          profit:'可获利', loss:'会亏钱', partial:'部分腿深度不足',
          noChecked:'未勾选任何选项', cantLocate:'未定位到下单区，请手动下单：', legs:'腿', confirmTitle:'确认下单', confirmBtn:'确认下单', cancelBtn:'取消', abortBtn:'中止',
          legProgress:'第', awaitingSign:'请在 MetaMask 签名…', switching:'切换中…',
          filledMsg:'已提交', timeoutMsg:'未确认成交 — 继续 / 跳过 / 中止',
          contBtn:'继续', skipBtn:'跳过', allDone:'全部已提交' },
  };
  let lang = localStorage.getItem('pb_lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
  const t = (k) => (STRINGS[lang] && STRINGS[lang][k]) || k;

  let active = null; // 当前已挂载面板 { slug, destroy }

  function getEventSlug() {
    // 解析逻辑在 clob.js 的 eventSlugFromPath（纯函数、有测试覆盖），兼容非英文语言前缀
    return eventSlugFromPath(location.pathname);
  }

  function onRouteChange() {
    const slug = getEventSlug();
    if (active && active.slug === slug) return;     // 同一 event，无需重挂
    if (active) { active.destroy(); active = null; } // 离开或切换，卸掉旧面板
    if (slug) active = mountPanel(slug);
  }

  function setLang(l) {
    if (l === lang) return;
    lang = l; localStorage.setItem('pb_lang', l);
    // ponytail: 切语言重建面板、重置勾选；语言是低频开头动作，保状态不值这点复杂度
    if (active) { const s = active.slug; active.destroy(); active = mountPanel(s); }
  }

  function mountPanel(slug) {
    const state = { dir: 'YES', shares: 100, checked: new Set(), bins: [] };
    const bookCache = {}; // tokenId -> { book, ts }
    let _gen = 0;         // recompute 代次，防过期写入

    const panel = document.createElement('div');
    panel.id = 'polybatch-panel';
    panel.innerHTML = `
      <div class="pb-head">
        <span class="pb-brand">Poly<b>Batch</b></span>
        <span class="pb-seg pb-lang">
          <button data-lang="en"${lang === 'en' ? ' class="active"' : ''}>EN</button><button data-lang="zh"${lang === 'zh' ? ' class="active"' : ''}>中</button>
        </span>
      </div>
      <div class="pb-slug"><span class="pb-slug-label">${t('market')}</span> <span class="pb-slug-val">${slug}</span></div>
      <div class="pb-body">
        <div class="pb-seg pb-dir">
          <button data-dir="YES" class="active">YES</button><button data-dir="NO">NO</button>
        </div>
        <label class="pb-share"><span>${t('buyPerBin')}</span>
          <input type="number" id="pb-shares" value="100" min="1"><i>${t('shares')}</i></label>
        <div id="pb-bins" class="pb-bins">${t('loading')}</div>
        <div class="pb-verdict" id="pb-total"></div>
        <button class="pb-submit" id="pb-submit">${t('place')}</button>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelectorAll('.pb-lang button').forEach(b =>
      b.addEventListener('click', () => setLang(b.dataset.lang)));

    panel.querySelectorAll('.pb-dir button').forEach(b =>
      b.addEventListener('click', () => {
        state.dir = b.dataset.dir;
        panel.querySelectorAll('.pb-dir button').forEach(x => x.classList.toggle('active', x === b));
        recompute();
      }));

    const sharesInput = panel.querySelector('#pb-shares');
    let debounce;
    sharesInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.shares = Number(sharesInput.value) || 0; recompute(); }, 300);
    });

    panel.querySelector('#pb-submit').addEventListener('click', onSubmit);

    fetchEventBins(slug).then(bins => { state.bins = bins; renderBins(); })
      .catch(() => { panel.querySelector('#pb-bins').textContent = t('noBins'); });

    function renderBins() {
      const host = panel.querySelector('#pb-bins');
      if (!state.bins.length) { host.textContent = t('noBins'); return; }
      host.innerHTML = '';
      state.bins.forEach((bin, i) => {
        const row = document.createElement('label');
        row.className = 'pb-leg-row';
        row.style.setProperty('--i', i); // 级联进入动画的索引
        row.innerHTML = `<input type="checkbox" data-i="${i}">
          <span class="pb-leg-title">${bin.title}</span>
          <span class="pb-leg-cost" data-i="${i}">·</span>`;
        row.querySelector('input').addEventListener('change', e => {
          row.classList.toggle('on', e.target.checked);
          if (e.target.checked) state.checked.add(i); else state.checked.delete(i);
          recompute();
        });
        host.appendChild(row);
      });
    }

    function tokenFor(bin) { return state.dir === 'YES' ? bin.yesToken : bin.noToken; }

    async function bookFor(bin) {
      const tok = tokenFor(bin);
      const c = bookCache[tok];
      if (c && (Date.now() - c.ts) < 30000) return c.book;
      const book = await fetchBook(tok);
      bookCache[tok] = { book, ts: Date.now() };
      return book;
    }

    async function recompute() {
      const gen = ++_gen;
      const avgPrices = [];
      let ok = true, totalShares = 0;
      for (let i = 0; i < state.bins.length; i++) {
        const cell = panel.querySelector(`.pb-leg-cost[data-i="${i}"]`);
        if (!cell) continue;
        if (!state.checked.has(i)) { cell.textContent = '·'; cell.className = 'pb-leg-cost'; continue; }
        let book;
        try { book = await bookFor(state.bins[i]); }
        catch { if (gen !== _gen) return; cell.textContent = t('loadFail'); cell.className = 'pb-leg-cost warn'; ok = false; continue; }
        if (gen !== _gen) return;
        const r = calcLegCost(book, state.shares);
        if (!r.enough) { cell.textContent = t('depth'); cell.className = 'pb-leg-cost warn'; ok = false; continue; }
        cell.textContent = `$${r.avgPrice.toFixed(3)}`;
        cell.className = 'pb-leg-cost';
        avgPrices.push(r.avgPrice); totalShares += r.filled;
      }
      renderVerdict(avgPrices, totalShares, ok);
    }

    function renderVerdict(avgPrices, totalShares, ok) {
      const el = panel.querySelector('#pb-total');
      const n = state.checked.size;
      if (!avgPrices.length) { el.innerHTML = `<div class="pb-empty">${n} ${t('legs')} · 0 ${t('shares')}</div>`; return; }
      const s = summarize(avgPrices, state.shares);
      const win = s.profitable;
      const pct = Math.min(s.combined, 1) * 100; // 标尺：满轨 = $1.00 基准
      el.innerHTML = `
        <div class="pb-combined ${win ? 'win' : 'lose'}">
          <span class="pb-num">$${s.combined.toFixed(3)}</span>
          <span class="pb-pill">${win ? t('profit') : t('loss')}</span>
        </div>
        <div class="pb-gauge"><div class="pb-gauge-fill ${win ? 'win' : 'lose'}" style="width:${pct}%"></div></div>
        <div class="pb-foot">
          <span>${t('spend')} <b>$${s.totalSpend.toFixed(2)}</b></span>
          <span>${n} ${t('legs')} · ${totalShares} ${t('shares')}</span>
        </div>
        ${ok ? '' : `<div class="pb-partial">${t('partial')}</div>`}`;
    }

    // 选择器从用户提供的真实下单区 + bin 行 HTML 提取（2026-06-29）
    const PB_SELECTORS = {
      binRow: 'a[data-id]',                              // bin 行（左侧温度选项，是 <a> 链接）
      binTitle: 'p.font-semibold.truncate',              // 行内标题（取文本匹配 bin.title）
      rowYes: 'button[class*="text-green-500"]',         // 行内 Buy Yes（绿）→ 选 bin+YES
      rowNo: 'button[class*="text-red-500"]',            // 行内 Buy No（红）→ 选 bin+NO
      limitPriceInput: 'input[inputmode="decimal"][placeholder="0.0¢"]', // 限价输入（美分）
      sharesInput: 'input[inputmode="decimal"][placeholder="0"]',        // 份额输入
      placeOrderBtn: '.trading-button[data-color="blue"]',               // Place buy order
    };
    const ORDER_TIMEOUT = 60000;

    function setNativeValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function submitLeg(leg) {
      // 1. 定位 bin 行（标题精确匹配），点行内方向按钮 → 右侧组件加载该 bin + 方向
      //    不点整行 <a>（会导航走）；方向靠按钮颜色（绿=Yes/红=No），文本不可靠
      const row = [...document.querySelectorAll(PB_SELECTORS.binRow)]
        .find(r => { const e = r.querySelector(PB_SELECTORS.binTitle); return e && e.textContent.trim() === leg.bin.title; });
      if (!row) throw new Error('bin');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const dirBtn = row.querySelector(leg.dir === 'YES' ? PB_SELECTORS.rowYes : PB_SELECTORS.rowNo);
      if (!dirBtn) throw new Error('dir');
      dirBtn.click();
      await sleep(500); // 等右侧组件加载该 bin

      // 2. 卖一价（美分）→ Limit price
      const book = await bookFor(leg.bin);
      const cents = bestAskCents(book);
      if (cents == null) throw new Error('ask');
      const priceInput = document.querySelector(PB_SELECTORS.limitPriceInput);
      if (!priceInput) throw new Error('price'); // 若组件落在 Market 模式会没此框
      setNativeValue(priceInput, cents);
      await sleep(150);

      // 3. 份额
      const sharesEl = document.querySelector(PB_SELECTORS.sharesInput);
      if (!sharesEl) throw new Error('shares');
      setNativeValue(sharesEl, leg.shares);
      await sleep(150);

      // 4. 点 Place buy order → 弹 MetaMask（用户签名）
      const btn = document.querySelector(PB_SELECTORS.placeOrderBtn);
      if (!btn) throw new Error('place');
      btn.click();
    }

    // 提交成功后 Polymarket 重置份额输入；检测到清空即视为该笔已提交
    // ponytail: 用表单重置作信号，比依赖一闪而过的 toast 选择器稳；真实页面验证若不准再换信号
    async function waitForFill(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const el = document.querySelector(PB_SELECTORS.sharesInput);
        if (!el || el.value === '' || el.value === '0') return 'filled';
        await sleep(500);
      }
      return 'timeout';
    }

    let _abort = false;

    function overlay(html) {
      let el = panel.querySelector('#pb-overlay');
      if (!el) { el = document.createElement('div'); el.id = 'pb-overlay'; panel.appendChild(el); }
      el.innerHTML = html;
      return el;
    }
    function clearOverlay() { const el = panel.querySelector('#pb-overlay'); if (el) el.remove(); }

    function collectLegs() {
      const legs = [];
      for (const i of state.checked) {
        const cell = panel.querySelector(`.pb-leg-cost[data-i="${i}"]`);
        const cost = cell ? Number(String(cell.textContent).replace(/[^0-9.]/g, '')) * state.shares : 0;
        legs.push({ bin: state.bins[i], title: state.bins[i].title, dir: state.dir, shares: state.shares, cost });
      }
      return legs;
    }

    async function onSubmit() {
      if (!state.checked.size) { alert(t('noChecked')); return; }
      const legs = collectLegs();
      const plan = buildOrderPlan(legs);
      // 确认步
      overlay(
        `<div class="pb-ov-title">${t('confirmTitle')}</div>
         <div class="pb-ov-sum">${plan.count} ${t('legs')} · ${state.dir} · $${plan.totalSpend.toFixed(2)}</div>
         <div class="pb-ov-list">${plan.items.map(it => `<div>${it.title} · ${it.shares}</div>`).join('')}</div>
         <div class="pb-ov-actions">
           <button id="pb-confirm" class="pb-submit">${t('confirmBtn')}</button>
           <button id="pb-cancel" class="pb-ghost">${t('cancelBtn')}</button>
         </div>`);
      panel.querySelector('#pb-cancel').onclick = clearOverlay;
      panel.querySelector('#pb-confirm').onclick = () => submitBatch(legs);
    }

    async function submitBatch(legs) {
      _abort = false;
      for (let i = 0; i < legs.length; i++) {
        if (_abort) break;
        const n = legs.length;
        const showAbort = `<button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>`;
        overlay(`<div class="pb-ov-prog">${t('legProgress')} ${i + 1}/${n} · ${t('switching')}</div>${showAbort}`);
        panel.querySelector('#pb-abort').onclick = () => { _abort = true; };
        try {
          await submitLeg(legs[i]);
        } catch (e) {
          overlay(`<div class="pb-ov-prog pb-warn">${t('legProgress')} ${i + 1}/${n} · ${String(e.message)}</div>
                   <button id="pb-skip" class="pb-ghost">${t('skipBtn')}</button>
                   <button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>`);
          const act = await new Promise(res => {
            panel.querySelector('#pb-skip').onclick = () => res('skip');
            panel.querySelector('#pb-abort').onclick = () => res('abort');
          });
          if (act === 'abort') break; else continue;
        }
        overlay(`<div class="pb-ov-prog">${t('legProgress')} ${i + 1}/${n} · ${t('awaitingSign')}</div>${showAbort}`);
        panel.querySelector('#pb-abort').onclick = () => { _abort = true; };
        const r = await waitForFill(ORDER_TIMEOUT);
        if (r === 'timeout') {
          overlay(`<div class="pb-ov-prog pb-warn">${t('legProgress')} ${i + 1}/${n} · ${t('timeoutMsg')}</div>
                   <button id="pb-cont" class="pb-ghost">${t('contBtn')}</button>
                   <button id="pb-skip" class="pb-ghost">${t('skipBtn')}</button>
                   <button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>`);
          const act = await new Promise(res => {
            panel.querySelector('#pb-cont').onclick = () => res('cont');
            panel.querySelector('#pb-skip').onclick = () => res('skip');
            panel.querySelector('#pb-abort').onclick = () => res('abort');
          });
          if (act === 'abort') break;
          if (act === 'cont') { i--; continue; } // 再等这一笔
          // skip → 继续下一笔
        }
      }
      overlay(`<div class="pb-ov-prog">${t('allDone')}</div>
               <button id="pb-close" class="pb-ghost">OK</button>`);
      panel.querySelector('#pb-close').onclick = clearOverlay;
    }

    return { slug, destroy: () => panel.remove() };
  }

  // SPA 路由：content script 跑在 isolated world，页面自身的 history.pushState 不经过我们的包装，
  // 故用轮询 location.href（最可靠，跨所有 SPA 路由机制）。
  let _lastUrl = location.href;
  setInterval(() => {
    if (location.href !== _lastUrl) { _lastUrl = location.href; onRouteChange(); }
  }, 400);
  window.addEventListener('popstate', onRouteChange);
  onRouteChange(); // 初始
})();
