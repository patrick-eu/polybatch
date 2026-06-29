// clob.test.js
const assert = require('assert');
const { parseBins, eventSlugFromPath, buildOrderPlan } = require('./clob.js');

// 基本解析：title / token 提取
const basic = parseBins([{ markets: [
  { groupItemTitle:'A', clobTokenIds:'["111","222"]' },
  { groupItemTitle:'B', clobTokenIds:'["333","444"]' },
]}]);
assert.strictEqual(basic.length, 2);
assert.strictEqual(basic[0].title, 'A');
assert.strictEqual(basic[0].yesToken, '111');
assert.strictEqual(basic[0].noToken, '222');

// 无 markets → []
assert.deepStrictEqual(parseBins([{}]), []);
assert.deepStrictEqual(parseBins([]), []);

// 单个 clobTokenIds 非法 → 跳过它，保留正常的
const mixed = parseBins([{ markets: [
  { groupItemTitle:'good', clobTokenIds:'["1","2"]' },
  { groupItemTitle:'bad',  clobTokenIds:'INVALID' },
]}]);
assert.deepStrictEqual(mixed.map(b => b.title), ['good']);

// sortBy='price'（概率竞争类）→ 按 yes 价(概率)降序
const byPrice = parseBins([{ sortBy:'price', markets:[
  { groupItemTitle:'low',  clobTokenIds:'["1","2"]', outcomePrices:'["0.10","0.90"]', groupItemThreshold:0 },
  { groupItemTitle:'high', clobTokenIds:'["3","4"]', outcomePrices:'["0.40","0.60"]', groupItemThreshold:1 },
  { groupItemTitle:'mid',  clobTokenIds:'["5","6"]', outcomePrices:'["0.25","0.75"]', groupItemThreshold:2 },
]}]);
assert.deepStrictEqual(byPrice.map(b => b.title), ['high','mid','low']);

// sortBy='price' 且多数 price 并列（各选项概率都极低）→ 用 groupItemThreshold 升序打破并列
const tie = parseBins([{ sortBy:'price', markets:[
  { groupItemTitle:'p5', clobTokenIds:'["1","2"]', outcomePrices:'["0.001","0.999"]', groupItemThreshold:5 },
  { groupItemTitle:'p0', clobTokenIds:'["3","4"]', outcomePrices:'["0.001","0.999"]', groupItemThreshold:0 },
  { groupItemTitle:'hi', clobTokenIds:'["5","6"]', outcomePrices:'["0.40","0.60"]',   groupItemThreshold:9 },
  { groupItemTitle:'p2', clobTokenIds:'["7","8"]', outcomePrices:'["0.001","0.999"]', groupItemThreshold:2 },
]}]);
assert.deepStrictEqual(tie.map(b => b.title), ['hi','p0','p2','p5']);

// 排序用 bestAsk 优先（网页显示价），流动性差时 bestAsk ≠ outcomePrices
// 若误用 outcomePrices 会得 ['a','b']（0.0015>0.001），用 bestAsk 应得 ['b','a']（0.003>0.001）
const ask = parseBins([{ sortBy:'price', markets:[
  { groupItemTitle:'a', clobTokenIds:'["1","2"]', bestAsk:0.001, outcomePrices:'["0.0015","0.9985"]', groupItemThreshold:0 },
  { groupItemTitle:'b', clobTokenIds:'["3","4"]', bestAsk:0.003, outcomePrices:'["0.001","0.999"]',   groupItemThreshold:1 },
]}]);
assert.deepStrictEqual(ask.map(b => b.title), ['b','a']);

// bestAsk 为 null（无卖单的冷门候选）→ 回退 outcomePrices，不能当成 0 排最后
// 若 Number(null)=0 被误用，high(op0.30) 会被排到 mid(op0.05) 之后；正确应回退后 high 在前
const askNull = parseBins([{ sortBy:'price', markets:[
  { groupItemTitle:'mid',  clobTokenIds:'["1","2"]', bestAsk:0.10, outcomePrices:'["0.10","0.90"]', groupItemThreshold:0 },
  { groupItemTitle:'high', clobTokenIds:'["3","4"]', bestAsk:null, outcomePrices:'["0.30","0.70"]', groupItemThreshold:1 },
]}]);
assert.deepStrictEqual(askNull.map(b => b.title), ['high','mid']);

// sortBy=None + 有 groupItemThreshold（有序选项类，如温度/利率）→ 按 threshold 升序
// gamma 数组顺序与价格都故意打乱，只有 threshold 能还原网页序
const byThr = parseBins([{ markets:[
  { groupItemTitle:'28C',   clobTokenIds:'["1","2"]', outcomePrices:'["0.01","0.99"]', groupItemThreshold:8 },
  { groupItemTitle:'20Cdn', clobTokenIds:'["3","4"]', outcomePrices:'["0.01","0.99"]', groupItemThreshold:0 },
  { groupItemTitle:'26C',   clobTokenIds:'["5","6"]', outcomePrices:'["0.99","0.01"]', groupItemThreshold:6 },
  { groupItemTitle:'21C',   clobTokenIds:'["7","8"]', outcomePrices:'["0.01","0.99"]', groupItemThreshold:1 },
]}]);
assert.deepStrictEqual(byThr.map(b => b.title), ['20Cdn','21C','26C','28C']);

// 无 sortBy 且无 threshold → 保持 gamma 原始顺序（安全兜底）
const kept = parseBins([{ markets:[
  { groupItemTitle:'a', clobTokenIds:'["1","2"]' },
  { groupItemTitle:'b', clobTokenIds:'["3","4"]' },
]}]);
assert.deepStrictEqual(kept.map(b => b.title), ['a','b']);

// 已结算 / 已淘汰 / 未激活的 market 被过滤，只保留可下注的
const live = parseBins([{ markets:[
  { groupItemTitle:'live',     clobTokenIds:'["1","2"]', acceptingOrders:true,  active:true,  closed:false },
  { groupItemTitle:'settled',  clobTokenIds:'["3","4"]', acceptingOrders:false, active:true,  closed:true },
  { groupItemTitle:'inactive', clobTokenIds:'["5","6"]', acceptingOrders:true,  active:false, closed:false },
]}]);
assert.deepStrictEqual(live.map(b => b.title), ['live']);

// event slug 解析：兼容非英文语言前缀（用户实测格式 /it/ /zh/ /zh-hant/）
assert.strictEqual(eventSlugFromPath('/event/fed-decision-in-july-181'), 'fed-decision-in-july-181');
assert.strictEqual(eventSlugFromPath('/it/event/fed-decision-in-july-181'), 'fed-decision-in-july-181');
assert.strictEqual(eventSlugFromPath('/zh/event/who-will-enter-iran'), 'who-will-enter-iran');
assert.strictEqual(eventSlugFromPath('/zh-hant/event/brazil-presidential-election'), 'brazil-presidential-election');
assert.strictEqual(eventSlugFromPath('/zh/politics'), null);   // 分类页非 event 页 → 不挂面板
assert.strictEqual(eventSlugFromPath('/'), null);

// 用户实测的真实非英文 event 页：event 后有 eventSlug + marketSlug 两段，必须取 eventSlug（第一段）
assert.strictEqual(
  eventSlugFromPath('/zh-hant/event/highest-temperature-in-guangzhou-on-june-29-2026/highest-temperature-in-guangzhou-on-june-29-2026-34c'),
  'highest-temperature-in-guangzhou-on-june-29-2026');
assert.strictEqual(
  eventSlugFromPath('/vi/event/highest-temperature-in-guangzhou-on-june-29-2026/highest-temperature-in-guangzhou-on-june-29-2026-34c'),
  'highest-temperature-in-guangzhou-on-june-29-2026');
assert.strictEqual(
  eventSlugFromPath('/de/event/highest-temperature-in-guangzhou-on-june-29-2026/highest-temperature-in-guangzhou-on-june-29-2026-34c'),
  'highest-temperature-in-guangzhou-on-june-29-2026');

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

console.log('clob.test.js PASS');
