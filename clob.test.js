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

// 单个 market 的 clobTokenIds 非法时只跳过它，保留正常的
const mixed = parseBins([{ markets: [
  { groupItemTitle:'good', clobTokenIds:'["1","2"]' },
  { groupItemTitle:'bad', clobTokenIds:'INVALID' },
]}]);
assert.strictEqual(mixed.length, 1);
assert.strictEqual(mixed[0].title, 'good');

console.log('clob.test.js PASS');
