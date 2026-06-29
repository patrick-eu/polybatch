// content.js
(function () {
  const slug = location.pathname.split('/')[2]; // /event/<slug>
  if (!slug) return;

  const state = { dir: 'YES', shares: 100, checked: new Set(), bins: [] };
  const bookCache = {}; // tokenId -> book
  let _gen = 0; // recompute 代次，防过期写入

  // 易变的页面选择器集中此处；值需在真实 event 页用 DevTools 确认后填入
  const PB_SELECTORS = {
    binCard: '[data-bin-card]',       // 按 bin 标题定位的下单卡片容器
    dirToggle: '[data-outcome]',      // YES/NO 切换控件
    shareInput: 'input[inputmode="decimal"]', // share 数输入框
  };

  const panel = document.createElement('div');
  panel.id = 'polybatch-panel';
  panel.innerHTML = `
    <h3>PolyBatch</h3>
    <div class="pb-row pb-dir">方向:
      <button data-dir="YES" class="active">YES</button>
      <button data-dir="NO">NO</button></div>
    <div class="pb-row">每个 bin 买 <input type="number" id="pb-shares" value="100" min="1"> share</div>
    <div id="pb-bins">加载中…</div>
    <div class="pb-total" id="pb-total"></div>
    <button class="pb-submit" id="pb-submit">下单</button>`;
  document.body.appendChild(panel);

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
    .catch(() => { panel.querySelector('#pb-bins').textContent = '未识别到可批量的 bin'; });

  function renderBins() {
    const host = panel.querySelector('#pb-bins');
    if (!state.bins.length) { host.textContent = '未识别到可批量的 bin'; return; }
    host.innerHTML = '';
    state.bins.forEach((bin, i) => {
      const row = document.createElement('div');
      row.className = 'pb-row';
      row.innerHTML = `<input type="checkbox" data-i="${i}">
        <label>${bin.title}</label><span class="pb-leg" data-i="${i}">--</span>`;
      row.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) state.checked.add(i); else state.checked.delete(i);
        recompute();
      });
      host.appendChild(row);
    });
  }

  function tokenFor(bin) { return state.dir === 'YES' ? bin.yesToken : bin.noToken; }

  async function bookFor(bin) {
    const t = tokenFor(bin);
    const c = bookCache[t];
    if (c && (Date.now() - c.ts) < 30000) return c.book;
    const book = await fetchBook(t);
    bookCache[t] = { book, ts: Date.now() };
    return book;
  }

  async function recompute() {
    const gen = ++_gen;
    let total = 0, totalShares = 0, ok = true;
    for (let i = 0; i < state.bins.length; i++) {
      const span = panel.querySelector(`.pb-leg[data-i="${i}"]`);
      if (!span) continue;
      if (!state.checked.has(i)) { span.textContent = '--'; span.className = 'pb-leg'; continue; }
      let book;
      try { book = await bookFor(state.bins[i]); }
      catch { if (gen !== _gen) return; span.textContent = '加载失败'; span.className = 'pb-leg pb-warn'; ok = false; continue; }
      if (gen !== _gen) return;
      const r = calcLegCost(book, state.shares);
      if (!r.enough) { span.textContent = '深度不足'; span.className = 'pb-leg pb-warn'; ok = false; continue; }
      span.textContent = `$${r.avgPrice.toFixed(2)} $${r.cost.toFixed(1)}`;
      span.className = 'pb-leg';
      total += r.cost; totalShares += r.filled;
    }
    const n = state.checked.size;
    const avg = totalShares > 0 ? total / totalShares : 0;
    panel.querySelector('#pb-total').innerHTML =
      `选中 ${n} 腿 · 共 ${totalShares} share<br>总成本 $${total.toFixed(1)} · 均价 $${avg.toFixed(2)}` +
      (ok ? '' : ' <span class="pb-warn">(部分腿深度不足)</span>');
  }

  async function submitLeg(leg) {
    const card = locateBinCard(leg.bin.title);
    if (!card) { alert(`未定位到 bin「${leg.bin.title}」的下单区，请手动下单`); return; }
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
    card.style.outline = '2px solid #4f7cff';            // 高亮，提示用户点 Buy + 签名
  }

  // ponytail: 子串匹配；若某 bin 标题是另一个的子串，需在真实 DOM 上改用精确的标题元素选择器（连同 PB_SELECTORS 一并确认）
  function locateBinCard(title) {
    const cards = document.querySelectorAll(PB_SELECTORS.binCard);
    return [...cards].find(c => c.textContent.includes(title)) || null;
  }

  async function onSubmit() {
    if (!state.checked.size) { alert('未勾选任何 bin'); return; }
    for (const i of state.checked) {
      await submitLeg({ bin: state.bins[i], dir: state.dir, shares: state.shares });
    }
  }
})();
