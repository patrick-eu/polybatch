# PolyBatch 半自动多腿下单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `submitLeg` 占位实现完善为半自动多腿下单——确认步 + 逐 bin 自动序列（点 bin→方向→数量→place buy order）+ 检测成交后自动进下一笔 + 进度/中止/超时暂停。

**Architecture:** 在现有 `content.js`（IIFE）的 `mountPanel` 内扩展：确认步与进度复用面板覆盖层；`submitBatch` 编排循环，`submitLeg` 跑单笔 DOM 序列，`waitForFill` 轮询检测成交。确认步汇总抽成 `clob.js` 的纯函数 `buildOrderPlan` 以便测试。所有易变页面选择器集中 `PB_SELECTORS`，从用户提供的真实下单区 HTML 提取。

**Tech Stack:** 原生 JS（ES2020），Chrome MV3 content script，Polymarket 天气 event 页 DOM。Node 仅跑纯函数自检。

## Global Constraints

- 无构建工具、无依赖、无框架；content script 文件不用 ES module，纯函数文件末尾 `if (typeof module !== 'undefined') module.exports = {...}`。
- 用户用 **MetaMask**，每笔弹签名窗，插件**不操作 MetaMask 弹窗**；用户唯一动作是点 MetaMask 签名确认。
- 单例下单组件：一次只绑定一个 bin，必须一笔完成（检测到成交）后再切下一个 bin。
- **真实花钱操作必须有确认步**：点「下单」后先显示「N 笔 · 方向 · 总花费」，用户确认才执行。
- 成交检测超时默认 `ORDER_TIMEOUT = 60000` ms；超时**暂停**给「继续/跳过/中止」，绝不盲目连发。
- 全程可中止；任一控件定位失败 → 暂停提示，不静默跳过。
- 下单失败不影响成本计算（计算器与下单解耦）。
- 所有易变选择器集中 `PB_SELECTORS`，值从真实页面 HTML 提取，不靠猜。
- **订单类型用限价单（Limit），价格填卖一价（best ask）**：挂在最低卖价，立即吃卖一档成交、不滑到更深档。不切 Market 模式（切了限价输入框会消失）。
- Limit price 输入框单位是**美分（¢）**（placeholder `0.0¢`）；卖一价 `0.999`（美元）→ `99.9`（美分），用纯函数 `bestAskCents` 转换。
- 切换 bin + 选方向二合一：点 bin 行内的 `Buy Yes`（绿）/ `Buy No`（红）按钮，把该 bin 以对应方向加载到右侧组件。不点整行 `<a>`（会导航离开多 bin 页）。两个按钮文本都渲染成 "Buy Yes"，**靠颜色区分方向，不靠文本**。
- 成交衔接信号：份额输入被清空 = 该笔已提交（`waitForFill`）。

---

### Task 1: buildOrderPlan — 确认步汇总（纯函数 + 自检）

**Files:**
- Modify: `clob.js`（加函数 + export）
- Modify: `clob.test.js`（加测试）

**Interfaces:**
- Produces: `buildOrderPlan(legs)` → `{ count:number, totalSpend:number, items:[{title,shares,dir,cost}] }`。`legs` 是已勾选并算过成本的腿数组，每项 `{title, shares, dir, cost}`。`count`=腿数，`totalSpend`=各腿 cost 之和，`items`=原样透传用于确认步逐行展示。

- [ ] **Step 1: 写失败测试**

在 `clob.test.js` 的 `console.log('clob.test.js PASS');` 之前插入：

```javascript
// buildOrderPlan：确认步汇总——笔数、总花费、逐行透传
const plan = buildOrderPlan([
  { title:'70-72°F', shares:100, dir:'YES', cost:31 },
  { title:'72-74°F', shares:100, dir:'YES', cost:28 },
]);
assert.strictEqual(plan.count, 2);
assert.ok(Math.abs(plan.totalSpend - 59) < 1e-9, `totalSpend=${plan.totalSpend}`);
assert.strictEqual(plan.items[0].title, '70-72°F');
assert.strictEqual(plan.items[1].dir, 'YES');
// 空 → count 0, totalSpend 0
const empty = buildOrderPlan([]);
assert.strictEqual(empty.count, 0);
assert.strictEqual(empty.totalSpend, 0);
```

并把顶部 require 改为含 `buildOrderPlan`：
```javascript
const { parseBins, eventSlugFromPath, buildOrderPlan } = require('./clob.js');
```

- [ ] **Step 2: 跑测试看失败**

Run: `node clob.test.js`
Expected: FAIL — `buildOrderPlan is not a function`

- [ ] **Step 3: 实现**

在 `clob.js` 的 `module.exports` 行之前加：
```javascript
// 确认步汇总：把已勾选并算过成本的腿汇总成笔数 + 总花费 + 逐行项
function buildOrderPlan(legs) {
  const items = (legs || []).map(l => ({ title: l.title, shares: l.shares, dir: l.dir, cost: l.cost }));
  const totalSpend = items.reduce((s, l) => s + (Number(l.cost) || 0), 0);
  return { count: items.length, totalSpend, items };
}
```
并把 export 改为：
```javascript
if (typeof module !== 'undefined') module.exports = { parseBins, fetchEventBins, fetchBook, eventSlugFromPath, buildOrderPlan };
```

- [ ] **Step 4: 跑测试看通过**

Run: `node clob.test.js`
Expected: `clob.test.js PASS`

- [ ] **Step 5: Commit**

```bash
git add clob.js clob.test.js
git commit -m "feat: buildOrderPlan confirm-step summary with self-check"
```

---

### Task 2: bestAskCents 纯函数 + submitLeg 限价序列 + waitForFill

**Files:**
- Modify: `cost.js`（加纯函数 `bestAskCents` + export）
- Modify: `cost.test.js`（加测试）
- Modify: `content.js`（`mountPanel` 内：更新 `PB_SELECTORS`、重写 `submitLeg`、加 `waitForFill`）

**Interfaces:**
- Consumes: `state.bins`（含 title/yesToken/noToken）、`state.dir`、`state.shares`、闭包内已有的 `bookFor(bin)`（返回 CLOB 订单簿 `{asks:[{price,size}]}`）。
- Produces:
  - `bestAskCents(book)` → 卖一价美分数（如 `99.9`），无卖单返回 `null`。
  - `async submitLeg(leg)` → 限价下单序列（点 bin 行方向按钮 → 填 Limit price 卖一价 → 填份额 → 点 place buy order），`leg = { bin:{title,...}, dir:'YES'|'NO', shares:number }`。控件找不到时 `throw new Error('<what>')`。
  - `async waitForFill(timeoutMs)` → `'filled' | 'timeout'`，份额输入被清空视为已提交。
  - `PB_SELECTORS`：7 个真实选择器常量（已从用户提供的真实 HTML 提取）。

- [ ] **Step 1: bestAskCents 失败测试**

在 `cost.test.js` 的最后一行（`console.log(...PASS)`）之前插入：
```javascript
// bestAskCents：卖一价（asks 最低价）→ 美分，保留 0.1¢
assert.strictEqual(bestAskCents({ asks:[{price:'0.999',size:'10'}] }), 99.9);
assert.strictEqual(bestAskCents({ asks:[{price:'0.50'},{price:'0.48'},{price:'0.52'}] }), 48); // 取最低
assert.strictEqual(bestAskCents({ asks:[{price:'0.02',size:'5'}] }), 2);
assert.strictEqual(bestAskCents({ asks:[] }), null);
assert.strictEqual(bestAskCents(null), null);
```
并把顶部 require 改为含 `bestAskCents`（按 cost.test.js 现有 require 行追加该名字）。

- [ ] **Step 2: 跑测试看失败**

Run: `node cost.test.js`
Expected: FAIL — `bestAskCents is not a function`

- [ ] **Step 3: 实现 bestAskCents**

在 `cost.js` 的 `module.exports` 行之前加：
```javascript
// 卖一价（asks 最低价，美元）→ 美分，保留 0.1¢；无卖单返回 null
function bestAskCents(book) {
  const asks = (book && book.asks) || [];
  let lowest = Infinity;
  for (const a of asks) { const p = Number(a.price); if (p > 0 && p < lowest) lowest = p; }
  if (!Number.isFinite(lowest)) return null;
  return Math.round(lowest * 1000) / 10; // 0.999 → 99.9
}
```
并把 export 行追加 `bestAskCents`（如 `module.exports = { calcLegCost, summarize, bestAskCents };`）。

- [ ] **Step 4: 跑测试看通过**

Run: `node cost.test.js`
Expected: 末行 PASS

- [ ] **Step 5: 更新 PB_SELECTORS + 重写 submitLeg + 加 waitForFill**

在 `mountPanel` 内，把现有 `PB_SELECTORS` 整块（含 `binCard`/`dirToggle`/`shareInput`）替换为：
```javascript
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
```
同时删除现有 `mountPanel` 内已废弃的 `locateBinCard` 函数（被新 `submitLeg` 取代）。

- [ ] **Step 6: 语法校验 + 纯函数回归**

Run: `node --check content.js && node cost.test.js`
Expected: 无语法错误 + cost.test.js 末行 PASS

- [ ] **Step 7: 真实页面验证（停在签名前）**

加载扩展，在真实天气 event 页 Console 手动验证定位：实现者临时把 `submitLeg` 第 4 步的 `btn.click()` 注释掉，对一个真实 bin 标题跑一次，确认：bin 行方向按钮被点中、右侧组件切到该 bin、Limit price 填入卖一价（美分）、份额已填。确认无误后恢复 `btn.click()`。
Expected: 右侧组件为目标 bin + 方向，限价/份额已正确填入。

- [ ] **Step 8: Commit**

```bash
git add cost.js cost.test.js content.js
git commit -m "feat: limit-order submitLeg with best-ask pricing + waitForFill"
```

---

### Task 3: submitBatch 编排 — 确认步 + 循环 + 进度/中止/超时

**Files:**
- Modify: `content.js`（`mountPanel` 内：加 `submitBatch`、确认/进度 UI；把现有 `onSubmit` 改为走确认步）
- Modify: `content.js`（STRINGS 加下单相关文案）

**Interfaces:**
- Consumes: `buildOrderPlan`（clob.js）、`submitLeg`/`waitForFill`/`ORDER_TIMEOUT`（Task 2）、`state`、`t()`。
- Produces: `async submitBatch()` — 收集勾选腿 → 确认步 → 循环逐笔 → 进度/中止/超时暂停。

- [ ] **Step 1: STRINGS 加下单文案**

在 `content.js` 的 `STRINGS` 里，en 与 zh 各加这些键（en 值/zh 值）：
```
confirmTitle: 'Confirm order' / '确认下单'
confirmBtn: 'Confirm' / '确认下单'
cancelBtn: 'Cancel' / '取消'
abortBtn: 'Abort' / '中止'
legProgress: 'Leg' / '第'        // 拼接用，见 Step 2
awaitingSign: 'Sign in MetaMask…' / '请在 MetaMask 签名…'
switching: 'Switching…' / '切换中…'
filledMsg: 'submitted' / '已提交'
timeoutMsg: 'not confirmed — continue / skip / abort' / '未确认成交 — 继续 / 跳过 / 中止'
contBtn: 'Continue' / '继续'
skipBtn: 'Skip' / '跳过'
allDone: 'All legs submitted' / '全部已提交'
```

- [ ] **Step 2: 实现 submitBatch + 确认/进度 UI，替换 onSubmit**

在 `mountPanel` 内，把现有 `onSubmit` 整个替换为：
```javascript
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
```

- [ ] **Step 3: panel.css 加覆盖层样式**

在 `panel.css` 末尾加：
```css
#polybatch-panel #pb-overlay { position:absolute; inset:0; z-index:6; background:rgba(13,16,22,.92); backdrop-filter:blur(8px); border-radius:inherit; padding:16px; display:flex; flex-direction:column; gap:10px; justify-content:center; }
#polybatch-panel .pb-ov-title { font-weight:700; font-size:14px; }
#polybatch-panel .pb-ov-sum { font-family:var(--pb-mono); color:var(--pb-accent-bright); }
#polybatch-panel .pb-ov-list { font-family:var(--pb-mono); font-size:11px; color:var(--pb-dim); max-height:90px; overflow:auto; }
#polybatch-panel .pb-ov-prog { font-family:var(--pb-mono); font-size:13px; }
#polybatch-panel .pb-ov-actions { display:flex; gap:8px; }
#polybatch-panel .pb-ghost { flex:1; padding:8px; border:1px solid var(--pb-line); border-radius:8px; background:var(--pb-surface); color:var(--pb-text); font-family:var(--pb-sans); font-size:12px; cursor:pointer; }
#polybatch-panel .pb-ghost:hover { background:var(--pb-surface-2); }
```

- [ ] **Step 4: 语法校验 + 纯函数回归**

Run: `node --check content.js && node clob.test.js`
Expected: 无语法错误 + `clob.test.js PASS`

- [ ] **Step 5: 真实页面验证**

加载扩展，勾选 2 个 bin → 点「下单」→ 确认步显示正确笔数/总花费 → 点「确认下单」→ 插件自动切第 1 个 bin、填数量、点 place buy order、弹 MetaMask → 签名 → 检测成交后自动进第 2 笔 → 完成显示「全部已提交」。验证中止按钮、超时暂停的三个选择可用。
（首次建议用最小份额真实验证，或先把 `placeOrderBtn` 点击临时禁用走完编排逻辑。）

- [ ] **Step 6: Commit**

```bash
git add content.js panel.css
git commit -m "feat: submitBatch orchestration — confirm step, progress, abort, timeout pause"
```

---

## Self-Review

**1. Spec coverage:**
- 确认步 → Task 3 onSubmit overlay。✓
- 逐 bin 限价序列（点 bin 行方向按钮 → 填卖一价 → 填份额 → place buy order）→ Task 2 submitLeg。✓
- 订单类型限价 + 卖一价定价 + 美分转换 → Task 2 bestAskCents + submitLeg。✓
- 检测成交自动衔接（份额清空）→ Task 2 waitForFill + Task 3 循环。✓
- 进度显示 / 中止 → Task 3。✓
- 超时暂停给继续/跳过/中止 → Task 3 timeout 分支。✓
- 定位失败暂停提示 → Task 2 throw + Task 3 catch 分支。✓
- 7 个选择器集中 PB_SELECTORS、从真实 HTML 提取 → Task 2 Step 5。✓
- 确认步汇总可测 → Task 1 buildOrderPlan；卖一价美分可测 → Task 2 bestAskCents。✓
- ORDER_TIMEOUT=60000 → Task 2 常量。✓
- 计算器与下单解耦 → 覆盖层独立、submitLeg 失败不动 recompute；面板成本仍用吃多档均价（calcLegCost 不变）。✓

**2. Placeholder scan:** PB_SELECTORS 值已从真实 HTML 提取并落定（非占位）；bestAskCents/submitLeg/waitForFill 均有完整代码。无 TBD/TODO。

**3. Type consistency:** `buildOrderPlan(legs)→{count,totalSpend,items}`、`bestAskCents(book)→number|null`、`leg={bin,title,dir,shares,cost}`、`submitLeg(leg)`、`waitForFill(ms)→'filled'|'timeout'`、`PB_SELECTORS` 七键在各 Task 间一致。Task 3 collectLegs 产出的 leg 形状与 Task 2 submitLeg 消费一致（含 bin/title/dir/shares）；submitLeg 用闭包内 bookFor + bestAskCents 取卖一价。✓
