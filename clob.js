// clob.js
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

function parseBins(eventArr) {
  const ev = eventArr && eventArr[0];
  if (!ev || !ev.markets) return [];
  const bins = ev.markets.flatMap(m => {
    try {
      const tokens = JSON.parse(m.clobTokenIds);
      let price = 0;
      try { price = Number(JSON.parse(m.outcomePrices)[0]) || 0; } catch {}
      return [{ title: m.groupItemTitle || m.question, yesToken: tokens[0], noToken: tokens[1], price }];
    } catch { return []; }
  });
  // 还原网页显示顺序：网页按 event.sortBy 排序。sortBy='price' 时按 yes 价(概率)降序；
  // 其他情况保持 gamma 原始顺序（如天气区间序），不破坏既有正确顺序。
  if (ev.sortBy === 'price') bins.sort((a, b) => b.price - a.price);
  return bins;
}

async function fetchEventBins(slug) {
  const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseBins(await r.json());
}

async function fetchBook(tokenId) {
  const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

if (typeof module !== 'undefined') module.exports = { parseBins, fetchEventBins, fetchBook };
