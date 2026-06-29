// content.js
(function () {
  // 面板文案：JS 内置双语字典（运行时可切换，chrome.i18n 做不到运行时切换）。
  const STRINGS = {
    en: { market:'MARKET', dir:'Direction', buyPerBin:'Buy per option', shares:'shares',
          loading:'Loading…', noBins:'No batchable options found', place:'Place orders',
          depth:'No depth', loadFail:'Load failed', spend:'Total spend',
          profit:'PROFITABLE', loss:'WILL LOSE', partial:'Some legs lack depth',
          noChecked:'No options selected', cantLocate:'Couldn’t locate order area — place manually:', legs:'legs' },
    zh: { market:'市场', dir:'方向', buyPerBin:'每个选项买', shares:'份额',
          loading:'加载中…', noBins:'未识别到可批量的选项', place:'下单',
          depth:'无深度', loadFail:'加载失败', spend:'总花费',
          profit:'可获利', loss:'会亏钱', partial:'部分腿深度不足',
          noChecked:'未勾选任何选项', cantLocate:'未定位到下单区，请手动下单：', legs:'腿' },
  };
  let lang = localStorage.getItem('pb_lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
  const t = (k) => (STRINGS[lang] && STRINGS[lang][k]) || k;

  // 易变的页面选择器集中此处；值需在真实 event 页用 DevTools 确认后填入
  const PB_SELECTORS = {
    binCard: '[data-bin-card]',
    dirToggle: '[data-outcome]',
    shareInput: 'input[inputmode="decimal"]',
  };

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

    async function submitLeg(leg) {
      const card = locateBinCard(leg.bin.title);
      if (!card) { alert(`${t('cantLocate')} ${leg.bin.title}`); return; }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });

      const dirBtn = [...card.querySelectorAll(PB_SELECTORS.dirToggle)]
        .find(el => el.textContent.trim().toUpperCase().startsWith(leg.dir));
      if (dirBtn) dirBtn.click();

      const input = card.querySelector(PB_SELECTORS.shareInput);
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(leg.shares));            // 绕过 React 受控组件
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      card.style.outline = '2px solid #5B8CFF';            // 高亮，提示用户点 Buy + 签名
    }

    // ponytail: 子串匹配；若某 bin 标题是另一个的子串，需在真实 DOM 上改用精确的标题元素选择器（连同 PB_SELECTORS 一并确认）
    function locateBinCard(title) {
      const cards = document.querySelectorAll(PB_SELECTORS.binCard);
      return [...cards].find(c => c.textContent.includes(title)) || null;
    }

    async function onSubmit() {
      if (!state.checked.size) { alert(t('noChecked')); return; }
      for (const i of state.checked) {
        await submitLeg({ bin: state.bins[i], dir: state.dir, shares: state.shares });
      }
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
