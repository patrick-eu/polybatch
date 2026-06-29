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

if (typeof module !== 'undefined') module.exports = { calcLegCost };
