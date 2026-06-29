// clob.js
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

function parseBins(eventArr) {
  const ev = eventArr && eventArr[0];
  if (!ev || !ev.markets) return [];
  const bins = ev.markets.flatMap(m => {
    // 只保留仍可下注的 bin：已结算 / 已淘汰 / 未激活的过滤掉
    if (m.acceptingOrders === false || m.closed === true || m.active === false) return [];
    try {
      const tokens = JSON.parse(m.clobTokenIds);
      let price = 0;
      try { price = Number(JSON.parse(m.outcomePrices)[0]) || 0; } catch {}
      return [{
        title: m.groupItemTitle || m.question,
        yesToken: tokens[0], noToken: tokens[1],
        price, threshold: Number(m.groupItemThreshold),
      }];
    } catch { return []; }
  });
  // 还原网页显示顺序（通用，不针对单一市场）：
  //  - sortBy='price'（概率竞争类，如候选人/球队）→ 按概率降序
  //  - 否则有完整 groupItemThreshold（有序选项类，如温度/利率档位）→ 按 threshold 升序
  //  - 都不满足 → 保持 gamma 原序
  if (ev.sortBy === 'price') {
    // price 降序为主键；price 并列（如各选项概率都极低）时按 groupItemThreshold 升序打破并列
    bins.sort((a, b) => (b.price - a.price) || (a.threshold - b.threshold) || 0);
  } else if (bins.every(b => Number.isFinite(b.threshold))) {
    bins.sort((a, b) => a.threshold - b.threshold);
  }
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
