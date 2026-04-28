const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const FMP_KEY = process.env.FMP_KEY;
const BASE = 'https://financialmodelingprep.com/api/v3';

app.get('/', (req, res) => res.json({ status: 'True Spread Analyzer API running' }));

// Price nearest to target date
app.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { date } = req.query;
    const d = new Date(date);
    const from = new Date(d); from.setDate(from.getDate() - 10);
    const to   = new Date(d); to.setDate(to.getDate() + 10);
    const url = `${BASE}/historical-price-full/${symbol}?from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const hist = data.historical || [];
    if (!hist.length) return res.status(404).json({ error: `No price data found for ${symbol} on FMP.` });
    const target = new Date(date).getTime();
    hist.sort((a, b) => Math.abs(new Date(a.date) - target) - Math.abs(new Date(b.date) - target));
    res.json({ price: hist[0].close, date: hist[0].date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full price history for a period — used to calculate drawdown and volatility
app.get('/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    const url = `${BASE}/historical-price-full/${symbol}?from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const hist = (data.historical || []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) return res.status(404).json({ error: `No history for ${symbol}` });

    const prices = hist.map(d => d.close);

    // Max Drawdown: largest peak-to-trough decline over the period
    let maxDrawdown = 0;
    let peak = prices[0];
    for (const p of prices) {
      if (p > peak) peak = p;
      const dd = (p - peak) / peak * 100;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    // Annualized Volatility: std dev of daily log returns * sqrt(252)
    const logReturns = [];
    for (let i = 1; i < prices.length; i++) {
      logReturns.push(Math.log(prices[i] / prices[i - 1]));
    }
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
    const url = `${BASE}/historical-price-full/stock_dividend/${symbol}?apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const divs = data.historical || [];
    const start = new Date(from).getTime();
    const end   = new Date(to).getTime();
    const inRange = divs.filter(d => {
      const dt = new Date(d.paymentDate || d.date).getTime();
      return dt >= start && dt <= end;
    });
    const total = inRange.reduce((a, d) => a + (parseFloat(d.dividend) || 0), 0);
    const perPayment = inRange.length > 0 ? total / inRange.length : 0;
    let freq = 'Quarterly';
    if (inRange.length > 2) {
      const sorted = inRange.map(d => new Date(d.paymentDate || d.date)).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i-1]) / 86400000);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      freq = avg < 45 ? 'Monthly' : avg > 200 ? 'Annually' : 'Quarterly';
    }
    res.json({ total, freq, count: inRange.length, perPayment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Company profile
app.get('/profile/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const url = `${BASE}/profile/${symbol}?apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    // Detect FMP rate-limit response so callers don't mistake it for "no profile"
    const obj = Array.isArray(data) ? data[0] : data;
    const fmpErr = (obj && obj['Error Message']) || (data && data['Error Message']) || '';
    if (typeof fmpErr === 'string' && (fmpErr.toLowerCase().includes('limit reach') || fmpErr.toLowerCase().includes('rate limit'))) {
      return res.status(429).json({ error: 'FMP rate limit reached.', code: 'RATE_LIMITED', fmpMessage: fmpErr });
    }
    const p = obj;
    if (!p || !p.companyName) return res.status(404).json({ error: `No profile found for ${symbol} on FMP.`, code: 'NO_PROFILE' });
    res.json({
      name: p.companyName || symbol,
      sector: p.sector || '',
      lastDiv: p.lastDiv || 0,
      price: p.price || 0,
      currentYield: p.lastDiv && p.price ? (p.lastDiv / p.price * 100).toFixed(2) : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dynamic dividend screener by sector
app.get('/screener', async (req, res) => {
  try {
    const { sector } = req.query;
    const sectorMap = {
      'Healthcare': 'Healthcare',
      'Consumer Staples': 'Consumer Defensive',
      'Consumer Disc.': 'Consumer Cyclical',
      'Industrials': 'Industrials',
      'Technology': 'Technology',
      'Financials': 'Financial Services',
      'Energy': 'Energy',
      'Utilities': 'Utilities',
      'Telecom': 'Communication Services',
      'REITs': 'Real Estate',
      'Materials': 'Basic Materials',
    };
    const fmpSector = sectorMap[sector] || sector;
    const url = `${BASE}/stock-screener?dividendMoreThan=0&sector=${encodeURIComponent(fmpSector)}&exchange=NYSE,NASDAQ,AMEX&limit=500&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!Array.isArray(data)) return res.status(500).json({ error: 'Unexpected FMP response' });
    const stocks = data
      .filter(s => s.symbol && s.lastAnnualDividend > 0)
      // ETFs, CEFs, income funds only — exclude plain company stocks
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
      .sort((a, b) => b.divYield - a.divYield)  // Highest yield first
      .slice(0, 15);
    res.json({ sector, fmpSector, count: stocks.length, stocks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bundled analysis — profile + start/end price + drawdown + volatility + dividends in one response.
// Replaces 5 separate client calls (/profile, /price x2, /history, /dividends) with 1.
// Internally fetches 3 FMP endpoints in parallel.
app.get('/analyze/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Missing from/to query params (YYYY-MM-DD).' });
    }

    // Buffer the price-history window so we can find a close trading day for the start/end dates.
    const fromD = new Date(from), toD = new Date(to);
    const fromBuf = new Date(fromD); fromBuf.setDate(fromBuf.getDate() - 10);
    const toBuf   = new Date(toD);   toBuf.setDate(toBuf.getDate() + 10);
    const fromBufStr = fromBuf.toISOString().split('T')[0];
    const toBufStr   = toBuf.toISOString().split('T')[0];

    const [profileR, histR, divR] = await Promise.all([
      fetch(`${BASE}/profile/${symbol}?apikey=${FMP_KEY}`),
      fetch(`${BASE}/historical-price-full/${symbol}?from=${fromBufStr}&to=${toBufStr}&apikey=${FMP_KEY}`),
      fetch(`${BASE}/historical-price-full/stock_dividend/${symbol}?apikey=${FMP_KEY}`)
    ]);

    const [profileData, histData, divData] = await Promise.all([
      profileR.json().catch(() => ({})),
      histR.json().catch(() => ({})),
      divR.json().catch(() => ({}))
    ]);

    // Detect FMP rate-limit response so we don't mis-report it as "no profile"
    const isFmpRateLimited = d => {
      if (!d) return false;
      const obj = Array.isArray(d) ? d[0] : d;
      const msg = (obj && obj['Error Message']) || d['Error Message'] || '';
      return typeof msg === 'string' && (msg.toLowerCase().includes('limit reach') || msg.toLowerCase().includes('rate limit'));
    };
    if (isFmpRateLimited(profileData) || isFmpRateLimited(histData) || isFmpRateLimited(divData)) {
      const fmpMsg = (profileData && profileData['Error Message']) || (histData && histData['Error Message']) || (divData && divData['Error Message']) || 'Rate limit reached';
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

    const hist = (histData.historical || []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) {
      return res.status(404).json({ error: `No price history for ${symbol} in window.`, code: 'NO_HISTORY' });
    }

    // Closest trading day to start / end target.
    const fromMs = fromD.getTime(), toMs = toD.getTime();
    let startBar = hist[0], startDelta = Math.abs(new Date(startBar.date).getTime() - fromMs);
    let endBar   = hist[hist.length - 1], endDelta = Math.abs(new Date(endBar.date).getTime() - toMs);
    for (const bar of hist) {
      const t = new Date(bar.date).getTime();
      const sd = Math.abs(t - fromMs); if (sd < startDelta) { startBar = bar; startDelta = sd; }
      const ed = Math.abs(t - toMs);   if (ed < endDelta)   { endBar = bar; endDelta = ed; }
    }

    // Drawdown + volatility computed over bars in [from, to] only.
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

    // Dividends in [from, to].
    const divs = divData.historical || [];
    const inRangeDivs = divs.filter(d => {
      const dt = new Date(d.paymentDate || d.date).getTime();
      return dt >= fromMs && dt <= toMs;
    });
    const dividendTotal = inRangeDivs.reduce((a, d) => a + (parseFloat(d.dividend) || 0), 0);
    const dividendPerPayment = inRangeDivs.length > 0 ? dividendTotal / inRangeDivs.length : 0;
    let dividendFrequency = 'Quarterly';
    if (inRangeDivs.length > 2) {
      const sortedDivs = inRangeDivs.map(d => new Date(d.paymentDate || d.date)).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sortedDivs.length; i++) gaps.push((sortedDivs[i] - sortedDivs[i - 1]) / 86400000);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      dividendFrequency = avg < 45 ? 'Monthly' : avg > 200 ? 'Annually' : 'Quarterly';
    }

    res.json({
      symbol,
      name: p.companyName || symbol,
      sector: p.sector || '',
      lastDiv: p.lastDiv || 0,
      price: p.price || 0,
      currentYield: p.lastDiv && p.price ? parseFloat((p.lastDiv / p.price * 100).toFixed(2)) : null,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TSA server running on port ${PORT}`));

// OHLC + volume history for TradingView chart
app.get('/ohlcv/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to } = req.query;
    const url = `${BASE}/historical-price-full/${symbol}?from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const hist = (data.historical || []).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!hist.length) return res.status(404).json({ error: `No OHLCV data for ${symbol}` });
    const ohlcv = hist.map(d => ({
      time: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume || 0
    }));
    res.json({ symbol, ohlcv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
