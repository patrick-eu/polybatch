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
assert.deepStrictEqual(bins[0], { title:'70-72°F', yesToken:'111', noToken:'222', price:0 });
assert.strictEqual(bins[1].yesToken, '333');

// 无 markets → []
assert.deepStrictEqual(parseBins([{}]), []);
assert.deepStrictEqual(parseBins([]), []);

// 单个 market 的 clobTokenIds 非法时只跳过它，保留正常的
const mixed = parseBins([{ markets: [
  { groupItemTitle:'good', clobTokenIds:'["1","2"]' },
  { groupItemTitle:'bad', clobTokenIds:'INVALID' },
]}]);
assert.strictEqual(mixed.length, 1);
assert.strictEqual(mixed[0].title, 'good');

// sortBy='price' 时按 yes 价(概率)降序还原网页顺序
const sorted = parseBins([{ sortBy:'price', markets:[
  { groupItemTitle:'low',  clobTokenIds:'["1","2"]', outcomePrices:'["0.10","0.90"]' },
  { groupItemTitle:'high', clobTokenIds:'["3","4"]', outcomePrices:'["0.40","0.60"]' },
  { groupItemTitle:'mid',  clobTokenIds:'["5","6"]', outcomePrices:'["0.25","0.75"]' },
]}]);
assert.deepStrictEqual(sorted.map(b => b.title), ['high','mid','low']);

// 无 sortBy（如天气区间）→ 保持 gamma 原始顺序，不破坏既有顺序
const kept = parseBins([{ markets:[
  { groupItemTitle:'a', clobTokenIds:'["1","2"]', outcomePrices:'["0.10","0.90"]' },
  { groupItemTitle:'b', clobTokenIds:'["3","4"]', outcomePrices:'["0.40","0.60"]' },
]}]);
assert.deepStrictEqual(kept.map(b => b.title), ['a','b']);

// 已结算 / 已淘汰 / 未激活的 market 被过滤，只保留可下注的
const live = parseBins([{ markets:[
  { groupItemTitle:'live',     clobTokenIds:'["1","2"]', acceptingOrders:true,  active:true,  closed:false },
  { groupItemTitle:'settled',  clobTokenIds:'["3","4"]', acceptingOrders:false, active:true,  closed:true },
  { groupItemTitle:'inactive', clobTokenIds:'["5","6"]', acceptingOrders:true,  active:false, closed:false },
]}]);
assert.deepStrictEqual(live.map(b => b.title), ['live']);

console.log('clob.test.js PASS');
