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

### Task 2: PB_SELECTORS 提取 + submitLeg 单笔序列 + waitForFill

**Files:**
- Modify: `content.js`（`mountPanel` 内：更新 `PB_SELECTORS`、重写 `submitLeg`、加 `waitForFill`）

**Interfaces:**
- Consumes: `state.bins`（含 title/yesToken/noToken）、`state.dir`、`state.shares`。
- Produces:
  - `async submitLeg(leg)` → 跑单笔 DOM 序列（点 bin → 选方向 → 填数量 → 点 place buy order），`leg = { bin:{title,...}, dir:'YES'|'NO', shares:number }`。控件找不到时 `throw new Error('locate:<what>')`。
  - `async waitForFill(timeoutMs)` → `'filled' | 'timeout'`，轮询检测成交信号。
  - `PB_SELECTORS`：6 个真实选择器常量。

**为什么选择器在此 Task 才确定：** Polymarket 是 SPA，下单区 DOM 只能在真实浏览器拿到。选择器值是本 Task Step 1 的产出。

- [ ] **Step 1: 从真实页面提取选择器**

请用户在真实天气 event 页打开 DevTools，复制以下三块 `outerHTML` 提供：右侧下单组件（含数量输入、YES/NO 控件、place buy order 按钮）、一个温度 bin 列表项、点下单后出现的成交成功 toast。据此填入 `PB_SELECTORS` 的 6 个值。把结果填进 Step 2 的常量。

- [ ] **Step 2: 更新 PB_SELECTORS（用 Step 1 确认的值）+ 重写 submitLeg + 加 waitForFill**

在 `mountPanel` 内，把现有 `PB_SELECTORS` 替换为（值用 Step 1 实际确认的，下面是结构与占位）：
```javascript
    const PB_SELECTORS = {
      binItem: '[data-bin-item]',          // 按 bin 标题定位的可点击温度选项（Step 1 确认）
      dirYes: '[data-outcome="yes"]',       // 右侧组件 YES 控件
      dirNo: '[data-outcome="no"]',         // 右侧组件 NO 控件
      amountInput: 'input[inputmode="decimal"]', // 数量输入框
      placeOrderBtn: '[data-testid="place-order"]', // place buy order 按钮
      fillSignal: '[data-toast="order-success"]',   // 成交成功 toast（或改为检测 amountInput 被清空）
    };
    const ORDER_TIMEOUT = 60000;

    function setNativeValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function submitLeg(leg) {
      // 1. 定位并点击该 bin → 右侧组件切到它
      const items = [...document.querySelectorAll(PB_SELECTORS.binItem)];
      const item = items.find(el => el.textContent.includes(leg.bin.title));
      if (!item) throw new Error('locate:bin');
      item.click();
      await sleep(400); // 等右侧组件切换渲染

      // 2. 选方向
      const dirBtn = document.querySelector(leg.dir === 'YES' ? PB_SELECTORS.dirYes : PB_SELECTORS.dirNo);
      if (!dirBtn) throw new Error('locate:dir');
      dirBtn.click();
      await sleep(150);

      // 3. 填数量
      const input = document.querySelector(PB_SELECTORS.amountInput);
      if (!input) throw new Error('locate:amount');
      setNativeValue(input, leg.shares);
      await sleep(150);

      // 4. 点 place buy order → 弹 MetaMask
      const btn = document.querySelector(PB_SELECTORS.placeOrderBtn);
      if (!btn) throw new Error('locate:placeOrder');
      btn.click();
    }

    // 轮询检测成交：成功 toast 出现即视为该笔完成
    async function waitForFill(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (document.querySelector(PB_SELECTORS.fillSignal)) return 'filled';
        await sleep(500);
      }
      return 'timeout';
    }
```

- [ ] **Step 3: 语法校验**

Run: `node --check content.js && echo "content.js syntax OK"`
Expected: `content.js syntax OK`

- [ ] **Step 4: 真实页面验证（停在签名前）**

加载扩展，在真实天气 event 页打开 Console，手动调用一次单笔序列**但不接通 place order 的真实点击**先验证定位：在 Console 跑（用真实 bin 标题）确认能定位 bin、方向、数量框（实现者临时把 `btn.click()` 注释掉跑一遍，确认前 3 步把右侧组件正确切到目标 bin、方向、数量已填）。确认无误后恢复 `btn.click()`。
Expected: 右侧组件切到目标 bin、方向正确、数量已填入。

- [ ] **Step 5: Commit**

```bash
git add content.js
git commit -m "feat: submitLeg DOM sequence + waitForFill (real selectors)"
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
- 逐 bin 自动序列（点 bin→方向→数量→place order）→ Task 2 submitLeg。✓
- 检测成交自动衔接 → Task 2 waitForFill + Task 3 循环。✓
- 进度显示 / 中止 → Task 3。✓
- 超时暂停给继续/跳过/中止 → Task 3 timeout 分支。✓
- 定位失败暂停提示 → Task 2 throw + Task 3 catch 分支。✓
- 6 个选择器集中 PB_SELECTORS、从真实 HTML 提取 → Task 2 Step 1。✓
- 确认步汇总可测 → Task 1 buildOrderPlan。✓
- ORDER_TIMEOUT=60000 → Task 2 常量。✓
- 计算器与下单解耦 → 覆盖层独立、submitLeg 失败不动 recompute。✓

**2. Placeholder scan:** Task 2 的 PB_SELECTORS 值是「从真实 HTML 提取」的产出并说明理由，非逃避占位；其余步骤均有完整代码。无 TBD/TODO。

**3. Type consistency:** `buildOrderPlan(legs)→{count,totalSpend,items}`、`leg={bin,title,dir,shares,cost}`、`submitLeg(leg)`、`waitForFill(ms)→'filled'|'timeout'`、`PB_SELECTORS` 六键在各 Task 间一致。Task 3 collectLegs 产出的 leg 形状与 Task 2 submitLeg 消费一致（含 bin/title/dir/shares）。✓
