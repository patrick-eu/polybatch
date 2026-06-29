# PolyBatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome 扩展，在 Polymarket event 页面注入浮层，勾选多个 bin、统一方向和 share 数，实时算总成本/均价，并半自动加速逐笔下单。

**Architecture:** MV3 扩展，无构建步骤、无框架、纯静态文件（加载已解压扩展）。三个 content script 文件按顺序加载，函数挂全局：`cost.js`（纯计算）、`clob.js`（网络层）、`content.js`（编排 + DOM）。下单动作抽象成 `submitLeg(leg)`，MVP 实现为"填页面表单"，未来可替换为私钥签名版。

**Tech Stack:** 原生 JS（ES2020），Chrome MV3，Polymarket gamma API + CLOB API。Node 仅用于跑纯函数自检（`node cost.test.js`），不进扩展包。

## Global Constraints

- 无构建工具、无 npm 依赖、无框架。扩展用 Chrome「加载已解压」直接运行。
- content script 文件不用 ES module；纯函数文件末尾加 `if (typeof module !== 'undefined') module.exports = {...}` 兼容 Node 测试，浏览器忽略。
- gamma API base：`https://gamma-api.polymarket.com`。CLOB API base：`https://clob.polymarket.com`。
- 价格单位 0–1 美元；`/book` 的 `price`/`size` 是字符串，用前转 `Number`。
- **CLOB `/book` 的 `asks` 按价格降序返回；买入吃单前必须升序排序，从最低价吃起。**
- `clobTokenIds` 是 JSON 字符串，`JSON.parse` 后 index 0 = YES token，index 1 = NO token。
- 测试无框架：纯 `assert`，每个纯函数文件配一个 `*.test.js`，`node` 直接跑。
- 提交粒度：每个 Task 末尾一次 commit。

---

### Task 1: cost.js — 吃单算成本（纯函数 + 自检）

**Files:**
- Create: `cost.js`
- Test: `cost.test.js`

**Interfaces:**
- Produces: `calcLegCost(book, shares)` → `{ filled:number, enough:boolean, cost:number, avgPrice:number }`。`book` 形如 `{asks:[{price,size}], bids:[...]}`（price/size 为字符串）。`shares` 为想买的 share 数。吃 `asks` 侧（买入），升序从最低价吃，累加 `price*size`。`filled`=实际吃到的 share，`enough`=是否吃满，`cost`=总成本，`avgPrice`=cost/filled（filled 为 0 时返回 0）。

- [ ] **Step 1: Write the failing test**

```javascript
// cost.test.js
const assert = require('assert');
const { calcLegCost } = require('./cost.js');

// asks 故意降序输入（模拟真实 API），价 0.30/100 + 0.28/50
const book = { asks: [{price:'0.30', size:'100'}, {price:'0.28', size:'50'}], bids: [] };

// 买 120：先吃 0.28*50=14，再 0.30*70=21 → cost 35, filled 120
const r = calcLegCost(book, 120);
assert.strictEqual(r.filled, 120);
assert.strictEqual(r.enough, true);
assert.ok(Math.abs(r.cost - 35) < 1e-9, `cost=${r.cost}`);
assert.ok(Math.abs(r.avgPrice - 35/120) < 1e-9, `avg=${r.avgPrice}`);

// 深度不足：总深度 150，买 200 → filled 150, enough false
const r2 = calcLegCost(book, 200);
assert.strictEqual(r2.filled, 150);
assert.strictEqual(r2.enough, false);

// 空簿：filled 0, avgPrice 0, 不除零
const r3 = calcLegCost({asks:[], bids:[]}, 100);
assert.strictEqual(r3.filled, 0);
assert.strictEqual(r3.avgPrice, 0);

console.log('cost.test.js PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node cost.test.js`
Expected: FAIL — `Cannot find module './cost.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// cost.js
function calcLegCost(book, shares) {
  const asks = (book.asks || [])
    .map(a => ({ price: Number(a.price), size: Number(a.size) }))
    .sort((a, b) => a.price - b.price); // 升序，从最低价吃
  let remaining = shares, cost = 0;
  for (const lvl of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    cost += take * lvl.price;
    remaining -= take;
  }
  const filled = shares - remaining;
  return {
    filled,
    enough: remaining <= 1e-9,
    cost,
    avgPrice: filled > 0 ? cost / filled : 0,
  };
}

if (typeof module !== 'undefined') module.exports = { calcLegCost };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node cost.test.js`
Expected: `cost.test.js PASS`

- [ ] **Step 5: Commit**

```bash
git add cost.js cost.test.js
git commit -m "feat: cost.js depth-eating cost calc with self-check"
```

---

### Task 2: clob.js — 取 bin 列表与订单簿（parse 纯函数可测 + fetch 包装）

**Files:**
- Create: `clob.js`
- Test: `clob.test.js`

**Interfaces:**
- Produces:
  - `parseBins(eventArr)` → `[{ title:string, yesToken:string, noToken:string }]`。输入是 gamma `/events?slug=` 的返回（数组），取 `[0].markets`，每个 market `JSON.parse(clobTokenIds)`，`title` 优先 `groupItemTitle` 否则 `question`。无 markets 返回 `[]`。
  - `async fetchEventBins(slug)` → 同上结构（内部 fetch + parseBins）。
  - `async fetchBook(tokenId)` → `{asks, bids, ...}`（CLOB `/book` 原样 JSON）。

- [ ] **Step 1: Write the failing test**

```javascript
// clob.test.js
const assert = require('assert');
const { parseBins } = require('./clob.js');

const eventArr = [{
  markets: [
    { groupItemTitle: '70-72°F', question: 'Will temp be 70-72?',
      clobTokenIds: '["111","222"]', outcomes: '["Yes","No"]' },
    { groupItemTitle: '72-74°F', question: 'Will temp be 72-74?',
      clobTokenIds: '["333","444"]', outcomes: '["Yes","No"]' },
  ],
}];

const bins = parseBins(eventArr);
assert.strictEqual(bins.length, 2);
assert.deepStrictEqual(bins[0], { title:'70-72°F', yesToken:'111', noToken:'222' });
assert.strictEqual(bins[1].yesToken, '333');

// 无 markets → []
assert.deepStrictEqual(parseBins([{}]), []);
assert.deepStrictEqual(parseBins([]), []);

console.log('clob.test.js PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node clob.test.js`
Expected: FAIL — `Cannot find module './clob.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// clob.js
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

function parseBins(eventArr) {
  const ev = eventArr && eventArr[0];
  if (!ev || !ev.markets) return [];
  return ev.markets.map(m => {
    const tokens = JSON.parse(m.clobTokenIds);
    return { title: m.groupItemTitle || m.question, yesToken: tokens[0], noToken: tokens[1] };
  });
}

async function fetchEventBins(slug) {
  const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  return parseBins(await r.json());
}

async function fetchBook(tokenId) {
  const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
  return r.json();
}

if (typeof module !== 'undefined') module.exports = { parseBins, fetchEventBins, fetchBook };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node clob.test.js`
Expected: `clob.test.js PASS`

- [ ] **Step 5: Commit**

```bash
git add clob.js clob.test.js
git commit -m "feat: clob.js gamma/CLOB fetch + parseBins"
```

---

### Task 3: 扩展骨架 — manifest + 浮层注入（手动验证）

**Files:**
- Create: `manifest.json`, `panel.css`, `content.js`
- Modify: 无

**Interfaces:**
- Consumes: 无（骨架）。
- Produces: 在 `polymarket.com/event/*` 页面右上角注入一个可见浮层容器 `#polybatch-panel`，含标题与一个占位文本。后续 Task 4 往里填内容。

注：先让注入可见、确认 content script 能跑起来，再接逻辑。`cost.js`/`clob.js` 此 Task 一并登记进 manifest（即使还没在 content.js 用），避免后续改 manifest。

- [ ] **Step 1: 写 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "PolyBatch",
  "version": "0.1.0",
  "description": "一键勾选多个 Polymarket bin、统一方向与 share 数、实时算成本并加速下单。",
  "content_scripts": [
    {
      "matches": ["https://polymarket.com/event/*"],
      "js": ["cost.js", "clob.js", "content.js"],
      "css": ["panel.css"],
      "run_at": "document_idle"
    }
  ],
  "host_permissions": [
    "https://gamma-api.polymarket.com/*",
    "https://clob.polymarket.com/*"
  ]
}
```

- [ ] **Step 2: 写 panel.css**

```css
#polybatch-panel {
  position: fixed; top: 80px; right: 16px; z-index: 999999;
  width: 280px; background: #1b1b1f; color: #eee;
  font: 13px/1.4 system-ui, sans-serif;
  border: 1px solid #3a3a40; border-radius: 8px; padding: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
#polybatch-panel h3 { margin: 0 0 8px; font-size: 14px; }
#polybatch-panel .pb-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
#polybatch-panel .pb-row label { flex: 1; }
#polybatch-panel .pb-dir button.active { background: #4f7cff; color: #fff; }
#polybatch-panel input[type=number] { width: 70px; background: #2a2a30; color: #eee; border: 1px solid #444; border-radius: 4px; }
#polybatch-panel .pb-total { margin-top: 8px; border-top: 1px solid #3a3a40; padding-top: 8px; }
#polybatch-panel .pb-submit { width: 100%; margin-top: 8px; padding: 6px; background: #4f7cff; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
#polybatch-panel .pb-warn { color: #ffb454; }
```

- [ ] **Step 3: 写 content.js 骨架（仅注入空面板）**

```javascript
// content.js — Task 3 骨架版（Task 4 会覆盖为完整版）
(function () {
  const slug = location.pathname.split('/')[2]; // /event/<slug>
  if (!slug) return;
  const panel = document.createElement('div');
  panel.id = 'polybatch-panel';
  panel.innerHTML = '<h3>PolyBatch</h3><div>面板已注入（骨架）</div>';
  document.body.appendChild(panel);
})();
```

- [ ] **Step 4: 手动验证注入**

1. Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选本项目目录。
2. 打开任意 `https://polymarket.com/event/<某 event>` 页面。
3. Expected: 右上角出现深色浮层，显示「PolyBatch / 面板已注入（骨架）」。无 console 报错。

- [ ] **Step 5: Commit**

```bash
git add manifest.json panel.css content.js
git commit -m "feat: MV3 skeleton + injected panel"
```

---

### Task 4: content.js 编排 — 渲染 bin、交互、实时算成本

**Files:**
- Modify: `content.js`（覆盖 Task 3 骨架为完整版）

**Interfaces:**
- Consumes: `fetchEventBins`/`fetchBook`（clob.js）、`calcLegCost`（cost.js）。
- Produces: 完整交互面板。下单走 `submitLeg(leg)`；本 Task 内 `submitLeg` 先用最小提示版（Task 5 替换为 DOM 填表单）。`leg` 形状 `{ bin:{title,yesToken,noToken}, dir:'YES'|'NO', shares:number }`。

设计要点：`bookCache[tokenId]` 缓存订单簿避免重复请求；share 输入 300ms 防抖；方向切换换 token 自然换缓存 key。
// ponytail: book 为打开时快照，不主动轮询；要更实时再加定时刷新。

- [ ] **Step 1: 写完整 content.js**

```javascript
// content.js
(function () {
  const slug = location.pathname.split('/')[2]; // /event/<slug>
  if (!slug) return;

  const state = { dir: 'YES', shares: 100, checked: new Set(), bins: [] };
  const bookCache = {}; // tokenId -> book

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
    if (!bookCache[t]) bookCache[t] = await fetchBook(t);
    return bookCache[t];
  }

  async function recompute() {
    let total = 0, totalShares = 0, ok = true;
    for (let i = 0; i < state.bins.length; i++) {
      const span = panel.querySelector(`.pb-leg[data-i="${i}"]`);
      if (!span) continue;
      if (!state.checked.has(i)) { span.textContent = '--'; span.className = 'pb-leg'; continue; }
      const book = await bookFor(state.bins[i]);
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
    // Task 5 替换为 DOM 填表单实现
    console.log('[PolyBatch] submitLeg', leg);
    alert(`请手动下单：${leg.dir} ${leg.bin.title} x${leg.shares} share（自动填表单下一版加入）`);
  }

  async function onSubmit() {
    if (!state.checked.size) { alert('未勾选任何 bin'); return; }
    for (const i of state.checked) {
      await submitLeg({ bin: state.bins[i], dir: state.dir, shares: state.shares });
    }
  }
})();
```

- [ ] **Step 2: 手动验证计算器**

1. `chrome://extensions` → 点该扩展的「重新加载」。
2. 打开一个**多 market** 的 event 页（如天气温度 event，或任意有多个并列 outcome 的 event）。
3. Expected:
   - 面板列出各 bin（带勾选框）。
   - 勾选 2–3 个 bin → 对应行显示 `$均价 $成本`，底部「总成本 / 均价」实时更新。
   - 改 share 数（如 100→500）→ 数字随之变化，均价因吃更深的单而变差。
   - 切 YES/NO → 数字变化。
   - 深度不足的腿显示「深度不足」并标橙。
4. 点「下单」→ 依次弹出每个勾选 bin 的提示（验证编排顺序正确）。

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: panel orchestration + live cost calc"
```

---

### Task 5: submitLeg — 半自动 DOM 填表单（选择器执行时验证）

**Files:**
- Modify: `content.js`（替换 `submitLeg` 函数 + 顶部加 `PB_SELECTORS` 常量）

**Interfaces:**
- Consumes: `leg = { bin:{title,yesToken,noToken}, dir, shares }`（Task 4 产出）。
- Produces: `submitLeg(leg)` 在页面上定位该 bin 的下单区、选方向、填 share 数、滚动到位并高亮，提示用户点 Buy + 签名。

**为什么选择器在此 Task 才确定：** Polymarket 是 SPA，渲染后的 DOM 只能在真实浏览器里拿到，无头环境取不到。选择器值是本 Task Step 1 的产出，不是预设常量——下面代码把所有易变选择器集中到 `PB_SELECTORS` 一处，便于改与降级。

- [ ] **Step 1: 在真实页面用 DevTools 确认选择器**

打开 event 页 → F12 → Elements，找到并记录：
- bin 下单区的容器及其与 `groupItemTitle` 文本的对应关系（如何按 bin 标题定位到它的下单卡片）。
- YES/NO 切换控件的选择器。
- share 数量输入框的选择器。
把结果填入 Step 2 的 `PB_SELECTORS`。若页面是「点某 bin 才展开单一下单区」，则 `locateBin` 改为先点击该 bin 行。

- [ ] **Step 2: 用确认到的选择器替换 submitLeg**

```javascript
// content.js 顶部（IIFE 内）加：
const PB_SELECTORS = {
  // ↓ Step 1 在真实页面确认后填入实际值
  binCard: '[data-bin-card]',       // 按 bin 标题定位的下单卡片容器
  dirToggle: '[data-outcome]',      // YES/NO 切换控件
  shareInput: 'input[inputmode="decimal"]', // share 数输入框
};

// 替换 Task 4 的 submitLeg：
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

function locateBinCard(title) {
  const cards = document.querySelectorAll(PB_SELECTORS.binCard);
  return [...cards].find(c => c.textContent.includes(title)) || null;
}
```

- [ ] **Step 3: 手动验证下单加速**

1. 重新加载扩展，打开 event 页，勾选 1 个 bin，设方向/share。
2. 点「下单」。
3. Expected: 页面滚动到该 bin 下单区、方向被切到目标、share 框被填入目标数、卡片高亮。**不自动点 Buy**（签名仍由用户完成）。
4. 勾选多个 bin → 依次定位填好。若某 bin 定位失败 → 弹提示且**计算器仍正常**（能力解耦）。

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: submitLeg semi-auto DOM prefill"
```

---

## Self-Review

**1. Spec coverage:**
- 成本计算器（核心）→ Task 1 + Task 4 recompute。✓
- 实时总成本/均价 → Task 4。✓
- 勾选多 bin / 统一方向 / 统一 share → Task 4 交互。✓
- 下单加速半自动 → Task 5。✓
- `submitLeg` 升级接口 → Task 4 定义、Task 5 实现，未来私钥版可替换同签名。✓
- 错误处理：深度不足、拿不到 bin、DOM 失效不拖垮计算器 → Task 4/5。✓
- 最小文件结构、无构建、自检 → Global Constraints + Task 1/2 测试。✓
- 砍掉 popup/订阅/私钥实现 → 未进任何 Task。✓

**2. Placeholder scan:** 无 TBD/TODO。Task 5 的选择器是「执行时探测产出」并已说明理由与集中位置，非逃避式占位。

**3. Type consistency:** `calcLegCost(book, shares)→{filled,enough,cost,avgPrice}`、`parseBins→{title,yesToken,noToken}`、`leg={bin,dir,shares}`、`submitLeg(leg)` 在各 Task 间名称与形状一致。✓

