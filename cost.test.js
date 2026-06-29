// cost.test.js
const assert = require('assert');
const { calcLegCost, summarize } = require('./cost.js');

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

console.log('cost.test.js PASS');
