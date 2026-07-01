// cost.test.js
const assert = require('assert');
const { calcLegCost, summarize, worstFillCents } = require('./cost.js');

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

// summarize: 综合成本 = 各腿均价之和；<1 可获利，>1 亏钱
const s = summarize([0.31, 0.28, 0.22], 100);
assert.ok(Math.abs(s.combined - 0.81) < 1e-9, `combined=${s.combined}`);
assert.ok(Math.abs(s.totalSpend - 81) < 1e-9, `spend=${s.totalSpend}`);
assert.strictEqual(s.profitable, true);
const s2 = summarize([0.5, 0.6], 100);
assert.ok(Math.abs(s2.combined - 1.1) < 1e-9, `combined2=${s2.combined}`);
assert.strictEqual(s2.profitable, false);

// worstFillCents：吃完 shares 深度所需的最高卖档价 → 美分，向上取整到 0.1¢
// 簿：0.48/50, 0.50/50, 0.52/100（乱序输入）
const wbook = { asks:[{price:'0.50',size:'50'},{price:'0.48',size:'50'},{price:'0.52',size:'100'}] };
assert.strictEqual(worstFillCents(wbook, 30), 48);   // 一档内 → 最低档
assert.strictEqual(worstFillCents(wbook, 50), 48);   // 正好吃完首档 → 仍是首档价
assert.strictEqual(worstFillCents(wbook, 80), 50);   // 跨到二档 → 50¢
assert.strictEqual(worstFillCents(wbook, 120), 52);  // 跨到三档 → 52¢
assert.strictEqual(worstFillCents(wbook, 999), 52);  // 深度不足 → 最高可得档
assert.strictEqual(worstFillCents({ asks:[{price:'0.465',size:'10'}] }, 5), 46.5); // 向上取整到 0.1¢
assert.strictEqual(worstFillCents({ asks:[] }, 10), null);
assert.strictEqual(worstFillCents(null, 10), null);

console.log('cost.test.js PASS');
