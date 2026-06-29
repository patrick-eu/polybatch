// clob.js
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

function parseBins(eventArr) {
  const ev = eventArr && eventArr[0];
  if (!ev || !ev.markets) return [];
  return ev.markets.flatMap(m => {
    try {
      const tokens = JSON.parse(m.clobTokenIds);
      return [{ title: m.groupItemTitle || m.question, yesToken: tokens[0], noToken: tokens[1] }];
    } catch { return []; }
  });
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
