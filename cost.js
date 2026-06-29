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

// 综合成本：选中各腿均价之和 = 买“一套”(每腿各 1 share)的价。
// >1 必亏(无论哪个结果命中，赔付仅 $1 < 成本)；<1 命中则可获利。
function summarize(avgPrices, shares) {
  const combined = avgPrices.reduce((s, p) => s + p, 0);
  return { combined, totalSpend: combined * shares, profitable: combined < 1 };
}

if (typeof module !== 'undefined') module.exports = { calcLegCost, summarize };
