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

// 吃到 shares 深度所需的「最差（最高）卖档价」→ 美分，向上取整到 0.1¢；无卖单返回 null。
// 限价买单会成交所有 ≤ 限价的卖档，故限价须挂到能覆盖所填深度的那一档，否则只吃到最低档、剩余不成交。
// 深度不足时挂最高可得卖档（尽量多成交）。向上取整确保限价 ≥ 该档实际价（否则差 0.0x¢ 会吃不到）。
function worstFillCents(book, shares) {
  const asks = ((book && book.asks) || [])
    .map(a => ({ price: Number(a.price), size: Number(a.size) }))
    .filter(a => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price); // 升序，从最低价吃
  if (!asks.length) return null;
  let remaining = shares, worst = 0;
  for (const lvl of asks) {
    worst = lvl.price;
    remaining -= lvl.size;
    if (remaining <= 1e-9) break;
  }
  return Math.ceil(worst * 1000) / 10; // 0.465 → 46.5
}

if (typeof module !== 'undefined') module.exports = { calcLegCost, summarize, worstFillCents };
