// Live prices for The Extinguisher (/invest-instead/).
//
// Pulls monthly price history plus the current price for each asset from
// Yahoo Finance, server-side, so the page needs no API key. Vercel's edge
// cache keeps the result for 15 minutes, so prices are never older than that.
//
// Response: { fetchedAt, assets: { BTC: { asOf, months: { "2024-01": 42000, ... } }, ... }, errors: { ... } }

const ASSETS = {
  BTC: "BTC-USD",
  SPX: "^GSPC",
  AAPL: "AAPL",
  AMZN: "AMZN",
  GOOGL: "GOOGL",
  META: "META",
};
const FIRST_MONTH = "1995-01";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; the-extinguisher/1.0)", Accept: "application/json" };

const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);

async function yahoo(symbol) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1mo&includePrePost=false`;
  let lastErr;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const res = await fetch(`https://${host}${path}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`Yahoo ${res.status}`);
      const json = await res.json();
      const r = json.chart && json.chart.result && json.chart.result[0];
      if (!r) throw new Error((json.chart && json.chart.error && json.chart.error.description) || "Yahoo: no data");
      // "close" is split-adjusted (not dividend-adjusted), which is what we want.
      const closes = r.indicators.quote[0].close;
      const months = {};
      r.timestamp.forEach((t, i) => {
        const c = closes[i];
        const k = monthKey(t * 1000);
        if (c != null && k >= FIRST_MONTH) months[k] = +c.toPrecision(6);
      });
      // The monthly bar lags; overwrite this month with the live price.
      const live = r.meta.regularMarketPrice;
      const asOf = (r.meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000;
      if (live) months[monthKey(asOf)] = +live.toPrecision(6);
      return { months, asOf };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Yahoo's BTC history only starts in late 2014, so fill the early years
// (the funniest ones) from CryptoCompare, which needs no key either.
async function earlyBitcoin() {
  const res = await fetch("https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&allData=true", { headers: HEADERS });
  const json = await res.json();
  if (json.Response !== "Success") throw new Error(json.Message || "CryptoCompare error");
  const months = {};
  for (const r of json.Data.Data) if (r.close > 0) months[monthKey(r.time * 1000)] = +r.close.toPrecision(6);
  return months;
}

module.exports = async (req, res) => {
  const out = { fetchedAt: Date.now(), assets: {}, errors: {} };
  const early = earlyBitcoin().catch(() => ({}));

  await Promise.all(Object.entries(ASSETS).map(async ([id, symbol]) => {
    try {
      out.assets[id] = await yahoo(symbol);
    } catch (e) {
      out.errors[id] = e.message;
    }
  }));

  const extra = await early;
  if (out.assets.BTC) {
    out.assets.BTC.months = { ...extra, ...out.assets.BTC.months };
  } else if (Object.keys(extra).length) {
    out.assets.BTC = { months: extra, asOf: Date.now() };
    delete out.errors.BTC;
  }

  const ok = Object.keys(out.assets).length > 0;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Cache good responses at the edge for 15 minutes; don't cache failures.
  res.setHeader("Cache-Control", ok ? "public, s-maxage=900, stale-while-revalidate=3600" : "no-store");
  res.statusCode = ok ? 200 : 502;
  res.end(JSON.stringify(out));
};
