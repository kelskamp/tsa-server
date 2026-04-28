const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FMP_KEY = process.env.FMP_KEY;
// Migrated to FMP's stable API (v3 was deprecated for new subscribers Aug 31, 2025).
// New patterns: symbol as ?symbol= query param, responses are direct arrays (no {historical:} wrapper),
// profile field renamed lastDiv -> lastDividend.
const BASE = 'https://financialmodelingprep.com/stable';

// Reusable: detect FMP's various rate-limit / error messages
const isFmpError = d => {
  if (!d) return false;
  const obj = Array.isArray(d) ? d[0] : d;
  const msg = (obj && obj['Error Message']) || d['Error Message'] || '';
  return typeof msg === 'string' && msg.length > 0 ? msg : null;
};
const isFmpRateLimited = d => {
  const msg = isFmpError(d);
  return msg && (msg.toLowerCase().includes('limit reach') || msg.toLowerCase().includes('rate limit'));
};

app.get('/', (req, res) => res.json({ status: 'TSA server running on FMP stable API' }));

// Price nearest to target date
app.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { date } = req.query;
    const d = new Date(date);
    const from = new Date(d); from.setDate(from.getDate() - 10);
    const to   = new Date(d); to.setDate(to.getDate() + 10);
    const url = `${BASE}/historical-price-eod/full?symbol=${symbol}&from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED' });
    const hist = Array.isArray(data) ? data : [];
    if (!hist.length) return res.status(404).json({ error: `No price data for ${symbol}.`, code: 'NO_DATA' });
    const target = new Date(date).getTime();
    hist.sort((a, b) => Math.abs(new Date(a.date) - target) - Math.abs(new Date(b.date) - target));
    res.json({ price: hist[0].close, date: hist[0].date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full price history for a period — drawdown + volatility
app.get('/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    const url = `${BASE}/historical-price-eod/full?symbol=${symbol}&from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED' });
    const hist = (Array.isArray(data) ? data : []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) return res.status(404).json({ error: `No history for ${symbol}`, code: 'NO_DATA' });

    const prices = hist.map(d => d.close);
    let maxDrawdown = 0, peak = prices[0];
    for (const p of prices) {
      if (p > peak) peak = p;
      const dd = (p - peak) / peak * 100;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
    const logReturns = [];
    for (let i = 1; i < prices.length; i++) logReturns.push(Math.log(prices[i] / prices[i - 1]));
    let volatility = 0;
    if (logReturns.length > 1) {
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
      volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }
    res.json({
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      volatility: parseFloat(volatility.toFixed(2)),
      dataPoints: prices.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dividends between two dates
app.get('/dividends/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    const url = `${BASE}/dividends?symbol=${symbol}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED' });
    const divs = Array.isArray(data) ? data : [];
    const start = new Date(from).getTime();
    const end   = new Date(to).getTime();
    const inRange = divs.filter(d => {
      const dt = new Date(d.paymentDate || d.date).getTime();
      return dt >= start && dt <= end;
    });
    const total = inRange.reduce((a, d) => a + (parseFloat(d.dividend) || 0), 0);
    const perPayment = inRange.length > 0 ? total / inRange.length : 0;
    // Stable API now includes per-record frequency. Use the most recent in-range one if present.
    let freq = (inRange[0] && inRange[0].frequency) || 'Quarterly';
    if (!inRange.length || !inRange[0].frequency) {
      // Fallback to gap-based heuristic for legacy compatibility
      if (inRange.length > 2) {
        const sorted = inRange.map(d => new Date(d.paymentDate || d.date)).sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i-1]) / 86400000);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        freq = avg < 45 ? 'Monthly' : avg > 200 ? 'Annually' : 'Quarterly';
      }
    }
    res.json({ total, freq, count: inRange.length, perPayment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Company profile
app.get('/profile/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const url = `${BASE}/profile?symbol=${symbol}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED', fmpMessage: isFmpError(data) });
    const p = Array.isArray(data) ? data[0] : data;
    if (!p || !p.companyName) return res.status(404).json({ error: `No profile found for ${symbol} on FMP.`, code: 'NO_PROFILE' });
    // Field rename: stable API uses `lastDividend` (was `lastDiv` in v3)
    const lastDiv = p.lastDividend || p.lastDiv || 0;
    res.json({
      name: p.companyName || symbol,
      sector: p.sector || '',
      lastDiv: lastDiv,
      price: p.price || 0,
      currentYield: lastDiv && p.price ? (lastDiv / p.price * 100).toFixed(2) : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sector screener — NOTE: v3 stock-screener may also be deprecated. Left as-is for now;
// will fail with legacy-endpoint error for stable-only subscribers. By Sector mode in the
// app uses this; if you hit issues, we'll migrate it next.
app.get('/screener', async (req, res) => {
  try {
    const { sector } = req.query;
    const sectorMap = {
      'Healthcare': 'Healthcare', 'Consumer Staples': 'Consumer Defensive',
      'Consumer Disc.': 'Consumer Cyclical', 'Industrials': 'Industrials',
      'Technology': 'Technology', 'Financials': 'Financial Services',
      'Energy': 'Energy', 'Utilities': 'Utilities',
      'Telecom': 'Communication Services', 'REITs': 'Real Estate',
      'Materials': 'Basic Materials',
    };
    const fmpSector = sectorMap[sector] || sector;
    const url = `${BASE}/company-screener?dividendMoreThan=0&sector=${encodeURIComponent(fmpSector)}&exchange=NYSE,NASDAQ,AMEX&limit=500&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED' });
    if (!Array.isArray(data)) return res.status(500).json({ error: 'Unexpected FMP response', code: 'BAD_RESPONSE' });
    const stocks = data
      .filter(s => s.symbol && s.lastAnnualDividend > 0)
      .filter(s => {
        const name = (s.companyName || '').toLowerCase();
        return s.isEtf === true || s.isFund === true ||
          name.includes('etf') || name.includes('fund') || name.includes('trust') ||
          name.includes('income') || name.includes('yield') || name.includes('strategy') ||
          name.includes('portfolio') || name.includes('reit') || name.includes('bdc');
      })
      .map(s => ({
        symbol: s.symbol,
        name: s.companyName || s.symbol,
        sector,
        lastDiv: s.lastAnnualDividend || 0,
        price: s.price || 0,
        divYield: s.price > 0 ? (s.lastAnnualDividend / s.price) * 100 : 0
      }))
      .sort((a, b) => b.divYield - a.divYield)
      .slice(0, 15);
    res.json({ sector, fmpSector, count: stocks.length, stocks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bundled analysis — profile + start/end price + drawdown + volatility + dividends in one response.
// Replaces 5 separate client calls with 1. Internally fetches 3 FMP endpoints in parallel.
app.get('/analyze/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Missing from/to query params (YYYY-MM-DD).' });
    }

    const fromD = new Date(from), toD = new Date(to);
    const fromBuf = new Date(fromD); fromBuf.setDate(fromBuf.getDate() - 10);
    const toBuf   = new Date(toD);   toBuf.setDate(toBuf.getDate() + 10);
    const fromBufStr = fromBuf.toISOString().split('T')[0];
    const toBufStr   = toBuf.toISOString().split('T')[0];

    const [profileR, histR, divR] = await Promise.all([
      fetch(`${BASE}/profile?symbol=${symbol}&apikey=${FMP_KEY}`),
      fetch(`${BASE}/historical-price-eod/full?symbol=${symbol}&from=${fromBufStr}&to=${toBufStr}&apikey=${FMP_KEY}`),
      fetch(`${BASE}/dividends?symbol=${symbol}&apikey=${FMP_KEY}`)
    ]);

    const [profileData, histData, divData] = await Promise.all([
      profileR.json().catch(() => ({})),
      histR.json().catch(() => ({})),
      divR.json().catch(() => ({}))
    ]);

    if (isFmpRateLimited(profileData) || isFmpRateLimited(histData) || isFmpRateLimited(divData)) {
      const fmpMsg = isFmpError(profileData) || isFmpError(histData) || isFmpError(divData) || 'Rate limit reached';
      return res.status(429).json({
        error: 'FMP rate limit reached. Try a smaller universe or wait ~60 seconds.',
        code: 'RATE_LIMITED',
        fmpMessage: fmpMsg
      });
    }

    const p = Array.isArray(profileData) ? profileData[0] : profileData;
    if (!p || !p.companyName) {
      return res.status(404).json({ error: `No profile found for ${symbol} on FMP.`, code: 'NO_PROFILE' });
    }

    const hist = (Array.isArray(histData) ? histData : []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) {
      return res.status(404).json({ error: `No price history for ${symbol} in window.`, code: 'NO_HISTORY' });
    }

    // Closest trading day to start / end target
    const fromMs = fromD.getTime(), toMs = toD.getTime();
    let startBar = hist[0], startDelta = Math.abs(new Date(startBar.date).getTime() - fromMs);
    let endBar   = hist[hist.length - 1], endDelta = Math.abs(new Date(endBar.date).getTime() - toMs);
    for (const bar of hist) {
      const t = new Date(bar.date).getTime();
      const sd = Math.abs(t - fromMs); if (sd < startDelta) { startBar = bar; startDelta = sd; }
      const ed = Math.abs(t - toMs);   if (ed < endDelta)   { endBar = bar; endDelta = ed; }
    }

    const inRange = hist.filter(bar => {
      const t = new Date(bar.date).getTime();
      return t >= fromMs && t <= toMs;
    });
    const prices = inRange.map(b => b.close);
    let maxDrawdown = 0;
    if (prices.length) {
      let peak = prices[0];
      for (const pr of prices) {
        if (pr > peak) peak = pr;
        const dd = (pr - peak) / peak * 100;
        if (dd < maxDrawdown) maxDrawdown = dd;
      }
    }
    let volatility = 0;
    if (prices.length > 1) {
      const logRet = [];
      for (let i = 1; i < prices.length; i++) logRet.push(Math.log(prices[i] / prices[i - 1]));
      if (logRet.length > 1) {
        const mean = logRet.reduce((a, b) => a + b, 0) / logRet.length;
        const variance = logRet.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / (logRet.length - 1);
        volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
      }
    }

    const divs = Array.isArray(divData) ? divData : [];
    const inRangeDivs = divs.filter(d => {
      const dt = new Date(d.paymentDate || d.date).getTime();
      return dt >= fromMs && dt <= toMs;
    });
    const dividendTotal = inRangeDivs.reduce((a, d) => a + (parseFloat(d.dividend) || 0), 0);
    const dividendPerPayment = inRangeDivs.length > 0 ? dividendTotal / inRangeDivs.length : 0;
    let dividendFrequency = (inRangeDivs[0] && inRangeDivs[0].frequency) || 'Quarterly';

    const lastDiv = p.lastDividend || p.lastDiv || 0;
    res.json({
      symbol,
      name: p.companyName || symbol,
      sector: p.sector || '',
      lastDiv: lastDiv,
      price: p.price || 0,
      currentYield: lastDiv && p.price ? parseFloat((lastDiv / p.price * 100).toFixed(2)) : null,
      startPrice: startBar.close,
      startDate: startBar.date,
      endPrice: endBar.close,
      endDate: endBar.date,
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      volatility: parseFloat(volatility.toFixed(2)),
      dataPoints: prices.length,
      dividendTotal,
      dividendFrequency,
      dividendCount: inRangeDivs.length,
      dividendPerPayment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OHLCV history for TradingView chart
app.get('/ohlcv/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    const url = `${BASE}/historical-price-eod/full?symbol=${symbol}&from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (isFmpRateLimited(data)) return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED' });
    const hist = (Array.isArray(data) ? data : []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) return res.status(404).json({ error: `No OHLCV data for ${symbol}`, code: 'NO_DATA' });
    const ohlcv = hist.map(d => ({
      time: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0
    }));
    res.json({ symbol, ohlcv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TSA server running on port ${PORT} (FMP stable API)`));
