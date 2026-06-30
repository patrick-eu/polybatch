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
          contBtn:'Continue', skipBtn:'Skip', allDone:'All legs submitted',
          aborted:'aborted', limitNote:'Limit @ best ask — size beyond the top ask may not fill',
          placing:'Placing…', placedAll:'orders placed — sign each in MetaMask' },
    zh: { market:'市场', dir:'方向', buyPerBin:'每个选项买', shares:'份额',
          loading:'加载中…', noBins:'未识别到可批量的选项', place:'下单',
          depth:'无深度', loadFail:'加载失败', spend:'总花费',
          profit:'可获利', loss:'会亏钱', partial:'部分腿深度不足',
          noChecked:'未勾选任何选项', cantLocate:'未定位到下单区，请手动下单：', legs:'腿', confirmTitle:'确认下单', confirmBtn:'确认下单', cancelBtn:'取消', abortBtn:'中止',
          legProgress:'第', awaitingSign:'请在 MetaMask 签名…', switching:'切换中…',
          filledMsg:'已提交', timeoutMsg:'未确认成交 — 继续 / 跳过 / 中止',
          contBtn:'继续', skipBtn:'跳过', allDone:'全部已提交',
          aborted:'已中止', limitNote:'限价挂卖一价，超出卖一档的份额可能不会成交',
          placing:'挂单中…', placedAll:'笔已挂出，请在 MetaMask 依次签名' },
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
      rowDirBtn: 'button',                               // 行内方向按钮（绿 Buy Yes / 红 Buy No），靠文本区分
      limitPriceInput: 'input[inputmode="decimal"][placeholder*="¢"]', // 限价输入（美分）；placeholder 在 0.0¢/0¢ 间变，用含¢子串匹配
      sharesInput: 'input[inputmode="decimal"][placeholder="0"]',      // 份额输入（placeholder 恒为 0，不带¢）
      placeOrderBtn: '.trading-button[data-color="blue"]',               // Place buy order
    };
    const ORDER_TIMEOUT = 60000;

    // 真实下单区是 react-number-format 类格式化输入：只派 input 不够，按钮验证不解锁。
    // 用原型 value setter 绕开 React 的 _valueTracker（保留实例 setter 时优先用它），
    // 再 focus→input→change→blur 走完一整条「人在打字」的事件链，触发校验、解锁按钮。
    function setNativeValue(input, value) {
      const proto = Object.getPrototypeOf(input);
      const protoSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const ownSetter = Object.getOwnPropertyDescriptor(input, 'value') &&
                        Object.getOwnPropertyDescriptor(input, 'value').set;
      const setter = (ownSetter && ownSetter !== protoSetter) ? ownSetter : protoSetter;
      input.focus();
      setter.call(input, '');                                       // 先清空，让格式化器从空重算
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 切 bin / 上一笔刚完成后，右侧下单组件会重渲染，输入框/按钮不是立即就位 → 轮询等它出现
    async function waitEl(sel, tries = 12, gap = 250) {
      let el = document.querySelector(sel);
      for (let k = 0; k < tries && !el; k++) { await sleep(gap); el = document.querySelector(sel); }
      return el;
    }

    // Place buy order 按钮无 disabled 属性、不换 class，禁用态只体现在两个 CSS 变量都为 0
    // （启用：--btn-hover-offset 1.5px / --btn-click-damping 2px；禁用：均 0px）。
    // ponytail: 依赖这两个 inline CSS 变量，页面改版需重核；这是当前唯一可观测的启用信号。
    function placeBtnEnabled(btn) {
      const cs = getComputedStyle(btn);
      const off = cs.getPropertyValue('--btn-hover-offset').trim();
      const damp = cs.getPropertyValue('--btn-click-damping').trim();
      return !(parseFloat(off) === 0 && parseFloat(damp) === 0);
    }

    // Place buy order 是 data-three-dee 动画按钮，下单逻辑绑在 pointer/mouse 事件上，
    // 单纯 .click() 只派 click（GTM 能抓到但不触发下单）。派完整指针序列才触发 React onPointerDown/Up。
    function realClick(el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
      const pdown = { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const pup = { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerover', pdown));
      el.dispatchEvent(new PointerEvent('pointerenter', pdown));
      el.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
      el.dispatchEvent(new PointerEvent('pointerdown', pdown));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', pup));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    }

    async function submitLeg(leg) {
      // 1. 定位 bin 行 + 方向按钮：页面用 Tailwind 工具类、无 data-id，类名/结构不稳，
      //    所以靠「内容」定位——找文本严格等于标题的叶子元素（排除本插件面板自身，标题在两处都出现），
      //    向上回溯到含 Buy Yes/Buy No 按钮的最近祖先即该 bin 行容器，再取对应方向按钮（点按钮不导航，非 <a>）。
      const wantText = leg.dir === 'YES' ? 'buy yes' : 'buy no';
      const titleEls = [...document.querySelectorAll('*')].filter(el =>
        el.children.length === 0 &&
        el.textContent.trim() === leg.bin.title &&
        !el.closest('#polybatch-panel'));
      let row = null, dirBtn = null;
      for (const el of titleEls) {
        let node = el;
        for (let up = 0; up < 8 && node; up++) {
          const btns = [...node.querySelectorAll('button')].filter(b => /buy (yes|no)/i.test(b.textContent));
          if (btns.length) { dirBtn = btns.find(b => b.textContent.toLowerCase().includes(wantText)); row = node; break; }
          node = node.parentElement;
        }
        if (row) break;
      }
      if (!row) throw new Error('bin');
      if (!dirBtn) throw new Error('dir');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      dirBtn.click();
      await sleep(500); // 等右侧组件加载该 bin

      // 2. 卖一价（美分）→ Limit price（轮询后仍无可能是组件落在 Market 模式，无限价框）
      const book = await bookFor(leg.bin);
      const cents = bestAskCents(book);
      if (cents == null) throw new Error('ask');
      const priceInput = await waitEl(PB_SELECTORS.limitPriceInput);
      if (!priceInput) throw new Error('price');
      setNativeValue(priceInput, cents);
      await sleep(150);

      // 3. 份额
      const sharesEl = await waitEl(PB_SELECTORS.sharesInput);
      if (!sharesEl) throw new Error('shares');
      setNativeValue(sharesEl, leg.shares);
      await sleep(150);

      // 4. 点 Place buy order → 弹 MetaMask（用户签名）。切到新 bin 后按钮可能还在重渲染，轮询等它出现。
      const btn = await waitEl(PB_SELECTORS.placeOrderBtn);
      if (!btn) throw new Error('place');
      // 等 React 跑完校验解锁按钮；仍禁用说明价/量没被接收，别点死按钮（否则静默无反应、不弹签名）
      for (let i = 0; i < 6 && !placeBtnEnabled(btn); i++) await sleep(250);
      if (!placeBtnEnabled(btn)) throw new Error('disabled');
      realClick(btn); // 必须用完整指针序列：单纯 .click() 不触发该动画按钮的下单逻辑、不弹签名
    }

    // 完成信号：下单按钮文字「Placing buy order」＝签名/提交进行中，会一直持续到 MetaMask 签完。
    // （份额输入是点击即清空的乐观重置，会在签名前就清，不能用作完成信号——实测踩过这个坑。）
    // 等到先见 Placing、再退出 Placing ＝ 本笔已签/已提交，才放行下一笔。
    // ponytail: 靠按钮文案，页面改版需重核；签名被拒同样会退出 Placing，按已完成处理（移到下一笔）。
    async function waitForFill(timeoutMs) {
      const start = Date.now();
      const isPlacing = () => {
        const b = document.querySelector(PB_SELECTORS.placeOrderBtn);
        return !!b && b.textContent.toLowerCase().includes('placing');
      };
      let sawPlacing = false;
      while (Date.now() - start < timeoutMs) {
        if (_abort) return 'abort';
        if (isPlacing()) sawPlacing = true;
        else if (sawPlacing) return 'filled';
        await sleep(300);
      }
      return 'timeout';
    }

    let _abort = false;
    let _running = false;

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
        const m = cell ? String(cell.textContent).match(/[\d.]+/) : null;
        if (!m) continue; // 无深度 / 加载失败 / 未计算 → 不计花费、不提交
        const cost = Number(m[0]) * state.shares;
        legs.push({ bin: state.bins[i], title: state.bins[i].title, dir: state.dir, shares: state.shares, cost });
      }
      return legs;
    }

    async function onSubmit() {
      if (_running) return;
      if (!state.checked.size) { alert(t('noChecked')); return; }
      const legs = collectLegs();
      if (!legs.length) { alert(t('noChecked')); return; }
      const plan = buildOrderPlan(legs);
      overlay(
        `<div class="pb-ov-title">${t('confirmTitle')}</div>
         <div class="pb-ov-sum">${plan.count} ${t('legs')} · ${state.dir} · $${plan.totalSpend.toFixed(2)}</div>
         <div class="pb-ov-list">${plan.items.map(it => `<div>${it.title} · ${it.shares}</div>`).join('')}</div>
         <div class="pb-ov-note">${t('limitNote')}</div>
         <div class="pb-ov-actions">
           <button id="pb-confirm" class="pb-submit">${t('confirmBtn')}</button>
           <button id="pb-cancel" class="pb-ghost">${t('cancelBtn')}</button>
         </div>`);
      panel.querySelector('#pb-cancel').onclick = clearOverlay;
      panel.querySelector('#pb-confirm').onclick = () => { _running = true; submitBatch(legs).finally(() => { _running = false; }); };
    }

    // 逐笔编排：确认 → 对每个勾选 bin 跑 submitLeg（弹 MetaMask）→ waitForFill 等签完 → 下一笔。
    // 任一步失败/超时都暂停让用户选（跳过/继续/中止），绝不盲目连发下一笔。
    async function submitBatch(legs) {
      _abort = false;
      let placed = 0, skipped = 0;
      for (let i = 0; i < legs.length; i++) {
        if (_abort) break;
        const n = legs.length;
        const showAbort = `<button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>`;
        overlay(`<div class="pb-ov-title">${t('legProgress')} ${i + 1}/${n} · ${t('placing')}</div>
                 <div class="pb-ov-actions">${showAbort}</div>`);
        panel.querySelector('#pb-abort').onclick = () => { _abort = true; };
        try {
          await submitLeg(legs[i]); // 点 bin→填价填量→place buy order，发起 MetaMask 签名
          placed++;
        } catch (e) {
          console.error('[PB] submitLeg 失败 leg', i + 1, e);
          overlay(`<div class="pb-ov-title pb-warn">${t('legProgress')} ${i + 1}/${n} · ${String(e.message)}</div>
                   <div class="pb-ov-actions">
                     <button id="pb-skip" class="pb-ghost">${t('skipBtn')}</button>
                     <button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>
                   </div>`);
          const act = await new Promise(res => {
            panel.querySelector('#pb-skip').onclick = () => res('skip');
            panel.querySelector('#pb-abort').onclick = () => res('abort');
          });
          if (act === 'abort') { _abort = true; break; }
          skipped++; continue;
        }
        // 逐笔等待：本笔已弹 MetaMask，必须等用户签完（下单表单复位＝份额被清空）再下一笔，
        // 否则下一笔的点击会被正打开的 MetaMask 挡掉而丢失（实验版连续下单就是这个 bug）。
        if (i < legs.length - 1) {
          overlay(`<div class="pb-ov-title">${t('legProgress')} ${i + 1}/${n} · ${t('awaitingSign')}</div>
                   <div class="pb-ov-actions">${showAbort}</div>`);
          panel.querySelector('#pb-abort').onclick = () => { _abort = true; };
          const r = await waitForFill(ORDER_TIMEOUT);
          if (r === 'abort') { _abort = true; break; }
          if (r === 'timeout') {
            // 没检测到本笔完成 → 暂停让用户决定，绝不盲目连发下一笔（设计 §4.3）
            overlay(`<div class="pb-ov-title pb-warn">${t('legProgress')} ${i + 1}/${n} · ${t('timeoutMsg')}</div>
                     <div class="pb-ov-actions">
                       <button id="pb-cont" class="pb-submit">${t('contBtn')}</button>
                       <button id="pb-abort" class="pb-ghost">${t('abortBtn')}</button>
                     </div>`);
            const act = await new Promise(res => {
              panel.querySelector('#pb-cont').onclick = () => res('cont');
              panel.querySelector('#pb-abort').onclick = () => res('abort');
            });
            if (act === 'abort') { _abort = true; break; }
          }
        }
      }
      const tail = `${placed} ${t('placedAll')}${skipped ? ' · ' + skipped + ' ' + t('skipBtn') : ''}${_abort ? ' · ' + t('aborted') : ''}`;
      overlay(`<div class="pb-ov-title">${tail}</div>
               <div class="pb-ov-actions"><button id="pb-close" class="pb-ghost">OK</button></div>`);
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
