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
    if (!hist.length) return res.status(404).json({ error: `No price data found for ${symbol} on FMP. This ticker may not be supported on your FMP plan.` });
    const target = new Date(date).getTime();
    hist.sort((a, b) => Math.abs(new Date(a.date) - target) - Math.abs(new Date(b.date) - target));
    res.json({ price: hist[0].close, date: hist[0].date });
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
    const p = Array.isArray(data) ? data[0] : data;
    if (!p || !p.companyName) return res.status(404).json({ error: `No profile found for ${symbol} on FMP.` });
    res.json({
      name: p.companyName || symbol,
      sector: p.sector || '',
      lastDiv: p.lastDiv || 0,
      price: p.price || 0,
      currentYield: p.lastDiv && p.price ? (p.lastDiv / p.price * 100).toFixed(2) : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dynamic dividend stock screener by sector
app.get('/screener', async (req, res) => {
  try {
    const { sector, exchange } = req.query;
    // FMP sector names differ slightly from our labels - map them
    const sectorMap = {
      'Healthcare':        'Healthcare',
      'Consumer Staples':  'Consumer Defensive',
      'Consumer Disc.':    'Consumer Cyclical',
      'Industrials':       'Industrials',
      'Technology':        'Technology',
      'Financials':        'Financial Services',
      'Energy':            'Energy',
      'Utilities':         'Utilities',
      'Telecom':           'Communication Services',
      'REITs':             'Real Estate',
      'Materials':         'Basic Materials',
    };
    const fmpSector = sectorMap[sector] || sector;
    // Get all stocks in sector that pay dividends (lastDiv > 0)
    const url = `${BASE}/stock-screener?dividendMoreThan=0&sector=${encodeURIComponent(fmpSector)}&exchange=NYSE,NASDAQ,AMEX&limit=500&apikey=${FMP_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!Array.isArray(data)) return res.status(500).json({ error: 'Unexpected FMP response', raw: data });
    // Map to our format
    const stocks = data
      .filter(s => s.symbol && s.lastAnnualDividend > 0)
      .map(s => ({
        symbol: s.symbol,
        name: s.companyName || s.symbol,
        sector: sector,
        lastDiv: s.lastAnnualDividend || 0,
        price: s.price || 0,
        marketCap: s.marketCap || 0,
      }))
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)); // largest first
    res.json({ sector, fmpSector, count: stocks.length, stocks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TSA server running on port ${PORT}`));
