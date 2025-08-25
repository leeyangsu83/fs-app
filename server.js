const express = require('express');
const cors = require('cors');
const path = require('path');
const Datastore = require('nedb-promises');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
// Prevent caching of frontend so updates are always loaded
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPEN_DART_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DB_PATH = path.join(__dirname, 'data', 'corpCodes.db');
const db = Datastore.create({ filename: DB_PATH, autoload: true });

app.use('/', express.static(path.join(__dirname, 'public')));

// Search corp by name (prefix/substring)
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const results = await db.find({ $or: [{ corp_name: regex }, { corp_eng_name: regex }] }).limit(20);
    res.json(results.map(({ corp_code, corp_name, stock_code }) => ({ corp_code, corp_name, stock_code })));
  } catch (e) {
    res.status(500).json({ error: 'search_failed', detail: e.message });
  }
});

// Fetch financials via OpenDART single account endpoint
app.get('/api/financials', async (req, res) => {
  try {
    const { corp_code, bsns_year, reprt_code, fs_div, sj_div } = req.query;
    const key = req.query.api_key || API_KEY;
    if (!corp_code || !bsns_year || !reprt_code) return res.status(400).json({ error: 'missing_params' });
    if (!key) return res.status(400).json({ error: 'missing_api_key' });
    const base = 'https://opendart.fss.or.kr/api';
    const qs = (p) => Object.entries(p).map(([k,v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const singleUrl = `${base}/fnlttSinglAcnt.json?${qs({ crtfc_key: key, corp_code, bsns_year, reprt_code, fs_div, sj_div })}`;

    let r = await fetch(singleUrl);
    let data = await r.json();
    const hasList = Array.isArray(data?.list) && data.list.length > 0 && data.status === '000';

    if (!hasList) {
      const allUrl = `${base}/fnlttSinglAcntAll.json?${qs({ crtfc_key: key, corp_code, bsns_year, reprt_code, fs_div, sj_div })}`;
      r = await fetch(allUrl);
      data = await r.json();
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', detail: e.message });
  }
});

// Compute key financial ratios and fetch stock metrics (PER/PBR/EPS) if stock_code exists
app.get('/api/metrics', async (req, res) => {
  try {
    const { corp_code, bsns_year, reprt_code } = req.query;
    const key = req.query.api_key || API_KEY;
    if (!corp_code || !bsns_year || !reprt_code) return res.status(400).json({ error: 'missing_params' });
    if (!key) return res.status(400).json({ error: 'missing_api_key' });

    // 1) Fetch financial rows (reuse internal logic similar to /api/financials)
    const base = 'https://opendart.fss.or.kr/api';
    const qs = (p) => Object.entries(p).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    const singleUrl = `${base}/fnlttSinglAcnt.json?${qs({ crtfc_key: key, corp_code, bsns_year, reprt_code })}`;
    let r = await fetch(singleUrl);
    let data = await r.json();
    let rows = Array.isArray(data?.list) ? data.list : [];
    if (!(Array.isArray(rows) && rows.length > 0 && data.status === '000')) {
      const allUrl = `${base}/fnlttSinglAcntAll.json?${qs({ crtfc_key: key, corp_code, bsns_year, reprt_code })}`;
      r = await fetch(allUrl);
      data = await r.json();
      rows = Array.isArray(data?.list) ? data.list : [];
    }

    // number helper
    const toNumber = (v) => {
      const s = String(v ?? '').replace(/,/g, '').trim();
      if (s === '' || s === '-') return NaN;
      const neg = /^\(.*\)$/.test(s);
      const core = neg ? s.slice(1, -1) : s;
      const n = Number(core);
      return neg ? -n : n;
    };

    // pick accounts by name
    const pick = (regex) => {
      const row = rows.find(x => regex.test(String(x.account_nm || '')));
      return row ? toNumber(row.thstrm_amount) : NaN;
    };

    const totalAssets = pick(/자산총계/);
    const totalLiab = pick(/부채총계/);
    const totalEquity = pick(/자본총계/);
    const revenue = pick(/(매출액|수익\(매출액\))/);
    const opIncome = pick(/영업이익/);
    const netIncome = pick(/(당기순이익|분기순이익|반기순이익)/);
    const retained = pick(/(이익잉여금|결손금)/);
    const capital = pick(/자본금/);
    const da = [
      pick(/감가상각비/),
      pick(/무형자산상각비/),
    ].filter(v => Number.isFinite(v)).reduce((a,b)=>a+b,0);
    const ebitda = (Number.isFinite(opIncome) ? opIncome : 0) + da;

    const ratio = (num, den) => (Number.isFinite(num) && Number.isFinite(den) && den !== 0) ? (num/den*100) : NaN;
    const debtRatio = ratio(totalLiab, totalEquity);
    const reserveRatio = ratio(retained, capital);
    const roa = ratio(netIncome, totalAssets);
    const roe = ratio(netIncome, totalEquity);

    // 2) Stock metrics via Naver Finance if possible
    let stock = await db.findOne({ corp_code });
    let per = NaN, pbr = NaN, eps = NaN;
    if (stock && stock.stock_code && /^\d{6}$/.test(String(stock.stock_code).trim())) {
      const code = String(stock.stock_code).trim();
      try {
        const resp = await fetch(`https://finance.naver.com/item/main.nhn?code=${code}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const html = await resp.text();
        const $ = cheerio.load(html);
        const parseNum = (s) => {
          if (!s) return NaN;
          const t = String(s).replace(/,/g, '').trim();
          const v = Number(t);
          return Number.isFinite(v) ? v : NaN;
        };
        // Prefer dedicated ids if present
        per = parseNum($('#_per').first().text());
        pbr = parseNum($('#_pbr').first().text());
        eps = parseNum($('#_eps').first().text());

        // Fallback: parse per_table rows by header labels
        const tryTable = (label) => {
          let val = NaN;
          $('table.per_table tr').each((_, tr) => {
            const th = $(tr).find('th').text();
            if (th && th.includes(label)) {
              const tdText = $(tr).find('td').text();
              const candidate = parseNum(tdText);
              if (Number.isFinite(candidate)) val = candidate;
            }
          });
          return val;
        };
        if (!Number.isFinite(per)) per = tryTable('PER');
        if (!Number.isFinite(pbr)) pbr = tryTable('PBR');
        if (!Number.isFinite(eps)) eps = tryTable('EPS');
      } catch {}
    }

    res.json({
      status: data?.status || '000',
      message: data?.message || 'OK',
      list: rows,
      metrics: {
        revenue, operatingIncome: opIncome, netIncome, totalAssets, totalLiabilities: totalLiab, totalEquity, ebitda,
        debtRatio, reserveRatio, roa, roe
      },
      stock: { stock_code: stock?.stock_code || null, per, pbr, eps }
    });
  } catch (e) {
    res.status(500).json({ error: 'metrics_failed', detail: e.message });
  }
});

// AI explanation using Gemini
app.get('/api/explain', async (req, res) => {
  try {
    const { corp_code, bsns_year, reprt_code } = req.query;
    const key = req.query.api_key || API_KEY;
    if (!corp_code || !bsns_year || !reprt_code) return res.status(400).json({ error: 'missing_params' });
    if (!key) return res.status(400).json({ error: 'missing_api_key' });
    if (!GEMINI_API_KEY) return res.status(400).json({ error: 'missing_gemini_key' });

    // Reuse metrics computation by calling the endpoint internally
    const url = `http://localhost:${PORT}/api/metrics?corp_code=${encodeURIComponent(corp_code)}&bsns_year=${encodeURIComponent(bsns_year)}&reprt_code=${encodeURIComponent(reprt_code)}&api_key=${encodeURIComponent(key)}`;
    const mr = await fetch(url);
    const m = await mr.json();
    if (!mr.ok) return res.status(500).json({ error: 'metrics_failed', detail: m?.error || 'unknown' });

    const corpRow = await db.findOne({ corp_code });
    const corpName = corpRow?.corp_name || corp_code;

    const prompt = [
      `다음 회사의 ${bsns_year}년도 보고서(${reprt_code}) 재무정보를 한국어로 간단하고 이해하기 쉽게 요약해 주세요.`,
      `회사: ${corpName} (${corp_code})`,
      `핵심지표(원 단위):`,
      `- 자산총계: ${m.metrics?.totalAssets ?? 'N/A'}`,
      `- 부채총계: ${m.metrics?.totalLiabilities ?? 'N/A'}`,
      `- 자본총계: ${m.metrics?.totalEquity ?? 'N/A'}`,
      `- 매출액: ${m.metrics?.revenue ?? 'N/A'}`,
      `- 영업이익: ${m.metrics?.operatingIncome ?? 'N/A'}`,
      `- 당기순이익: ${m.metrics?.netIncome ?? 'N/A'}`,
      `- EBITDA: ${m.metrics?.ebitda ?? 'N/A'}`,
      `재무비율(%): 부채비율=${m.metrics?.debtRatio ?? 'N/A'}, 유보율=${m.metrics?.reserveRatio ?? 'N/A'}, ROA=${m.metrics?.roa ?? 'N/A'}, ROE=${m.metrics?.roe ?? 'N/A'}`,
      m.stock?.stock_code ? `종목지표: PER=${m.stock?.per ?? 'N/A'}, PBR=${m.stock?.pbr ?? 'N/A'}, EPS=${m.stock?.eps ?? 'N/A'}` : '종목지표: 비상장 또는 종목코드 없음',
      `설명 형식: 1) 전반 요약 2) 수익성/성장성 3) 재무건전성 4) 종합 코멘트`
    ].join('\n');

    const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [ { role: 'user', parts: [ { text: prompt } ] } ]
      })
    });
    const g = await gr.json();
    const text = g?.candidates?.[0]?.content?.parts?.[0]?.text || '설명을 생성하지 못했습니다.';
    res.json({ status: '000', text });
  } catch (e) {
    res.status(500).json({ error: 'explain_failed', detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));


