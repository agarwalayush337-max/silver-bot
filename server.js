process.on('uncaughtException', err => {
  if (err.message?.includes('Redis')) {
    console.warn("⚠️ Redis error ignored:", err.message);
  } else {
    throw err;
  }
});

process.on('unhandledRejection', err => {
  if (err?.message?.includes('Redis')) {
    console.warn("⚠️ Redis rejection ignored:", err.message);
  }
});


/***********************


 * IMPORTS
 ***********************/
const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const WebSocket = require('ws');
const { EMA, SMA, ATR } = require("technicalindicators");

/***********************
 * APP
 ***********************/
const app = express();
app.use(express.urlencoded({ extended: true }));

/***********************
 * CONFIG
 ***********************/
const INSTRUMENT_KEY = "MCX_FO|458305";
const MAX_QUANTITY = 1;

/***********************
 * ENV
 ***********************/
const {
  UPSTOX_USER_ID,
  UPSTOX_PIN,
  UPSTOX_TOTP_SECRET,
  API_KEY,
  API_SECRET,
  REDIRECT_URI,
  REDIS_URL
} = process.env;

/***********************
 * REDIS (SAFE MODE)
 ***********************/
let redis = null;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    }
  });

  redis.on('connect', () => console.log("✅ Redis connected"));
  redis.on('error', err => console.warn("⚠️ Redis error:", err.message));
} else {
  console.warn("⚠️ REDIS_URL not set. Running without persistence.");
}

/***********************
 * GLOBAL STATE
 ***********************/
let ACCESS_TOKEN = null;
let lastKnownLtp = 0;
let ws = null;

let botState = {
  positionType: null,
  entryPrice: 0,
  exitPrice: 0,
  currentStop: null,
  slOrderId: null,
  quantity: 0,
  totalPnL: 0,
  pnlHistory: [],
  history: []
};

/***********************
 * STATE PERSISTENCE
 ***********************/
async function loadState() {
  if (!redis) return;
  try {
    const saved = await redis.get('silver_bot_state');
    if (saved) botState = JSON.parse(saved);
    console.log("📂 State loaded");
  } catch {
    console.warn("⚠️ Redis load skipped");
  }
}

async function saveState() {
  if (!redis) return;
  try {
    await redis.set('silver_bot_state', JSON.stringify(botState));
  } catch {
    console.warn("⚠️ Redis save skipped");
  }
}

loadState();

/***********************
 * TIME HELPERS
 ***********************/
function getIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
function isMarketOpen() {
  const t = getIST();
  const m = t.getHours() * 60 + t.getMinutes();
  return t.getDay() !== 0 && t.getDay() !== 6 && m >= 540 && m < 1430;
}

/***********************
 * AUTO LOGIN
 ***********************/
async function performAutoLogin() {
  let browser;
  try {
    console.log("🤖 Auto login started");

    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET),
      digits: 6,
      period: 30
    });

    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();

    await page.goto(
      `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`,
      { waitUntil: 'domcontentloaded' }
    );

    await page.type('#mobileNum', UPSTOX_USER_ID);
    await page.click('#getOtp');

    await page.waitForSelector('#otpNum');
    await page.type('#otpNum', totp.generate());
    await page.click('#continueBtn');

    await page.waitForSelector('#pinCode');
    await page.type('#pinCode', UPSTOX_PIN);
    await page.click('#pinContinueBtn');

    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    const code = new URL(page.url()).searchParams.get('code');

    const params = new URLSearchParams({
      code,
      client_id: API_KEY,
      client_secret: API_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const res = await axios.post(
      'https://api.upstox.com/v2/login/authorization/token',
      params
    );

    ACCESS_TOKEN = res.data.access_token;
    console.log("✅ Login success");

    await startMarketWS();
  } catch (e) {
    console.error("❌ Login failed:", e.message);
  } finally {
    if (browser) await browser.close();
  }
}

/***********************
 * MARKET DATA WEBSOCKET
 ***********************/
async function startMarketWS() {
  try {
    const auth = await axios.get(
      'https://api.upstox.com/v3/market-data-feed/authorize',
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    ws = new WebSocket(auth.data.data.authorized_redirect_uri);

    ws.on('open', () => {
      console.log("📡 Market WS connected");
      ws.send(JSON.stringify({
        guid: "silver-feed",
        method: "sub",
        data: { instrumentKeys: [INSTRUMENT_KEY] }
      }));
    });

    ws.on('message', msg => {
      const data = JSON.parse(msg);
      if (data?.data?.ltp) lastKnownLtp = data.data.ltp;
    });

    ws.on('close', () => setTimeout(startMarketWS, 3000));
  } catch (e) {
    console.error("WS error:", e.message);
  }
}

/***********************
 * SL HELPERS
 ***********************/
async function placeSL(trigger, side) {
  const tx = side === 'LONG' ? 'SELL' : 'BUY';

  const res = await axios.post(
    'https://api.upstox.com/v3/order/place',
    {
      instrument_token: INSTRUMENT_KEY,
      quantity: botState.quantity,
      order_type: "SL-M",
      transaction_type: tx,
      trigger_price: Math.round(trigger),
      product: "I",
      validity: "DAY"
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );

  botState.slOrderId = res.data.data.order_id;
  await saveState();
}

async function modifySL(trigger) {
  if (!botState.slOrderId) return;

  await axios.put(
    'https://api.upstox.com/v3/order/modify',
    {
      order_id: botState.slOrderId,
      trigger_price: Math.round(trigger)
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

/***********************
 * STRATEGY LOOP (UNCHANGED LOGIC)
 ***********************/
setInterval(async () => {
  if (!ACCESS_TOKEN || !isMarketOpen()) return;

  try {
    const res = await axios.get(
      `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const candles = res.data.data.candles;
    if (candles.length < 200) return;

    const close = candles.map(c => c[4]);
    const high = candles.map(c => c[2]);
    const low = candles.map(c => c[3]);
    const vol = candles.map(c => c[5]);

    const e50 = EMA.calculate({ period: 50, values: close });
    const e200 = EMA.calculate({ period: 200, values: close });
    const atr = ATR.calculate({ high, low, close, period: 14 });

    const curA = atr.at(-1);
    const bH = Math.max(...high.slice(-11, -1));
    const bL = Math.min(...low.slice(-11, -1));

    if (!botState.positionType) {
      if (e50.at(-2) > e200.at(-2) && close.at(-1) > bH) {
        botState.positionType = 'LONG';
        botState.entryPrice = lastKnownLtp;
        botState.quantity = MAX_QUANTITY;
        botState.currentStop = lastKnownLtp - curA * 3;
        await placeSL(botState.currentStop, 'LONG');
      }
      if (e50.at(-2) < e200.at(-2) && close.at(-1) < bL) {
        botState.positionType = 'SHORT';
        botState.entryPrice = lastKnownLtp;
        botState.quantity = MAX_QUANTITY;
        botState.currentStop = lastKnownLtp + curA * 3;
        await placeSL(botState.currentStop, 'SHORT');
      }
    } else {
      if (botState.positionType === 'LONG') {
        const newSL = Math.max(botState.currentStop, lastKnownLtp - curA * 3);
        if (newSL !== botState.currentStop) {
          botState.currentStop = newSL;
          await modifySL(newSL);
        }
      } else {
        const newSL = Math.min(botState.currentStop, lastKnownLtp + curA * 3);
        if (newSL !== botState.currentStop) {
          botState.currentStop = newSL;
          await modifySL(newSL);
        }
      }
    }

    await saveState();
  } catch (e) {
    console.warn("Strategy loop skipped:", e.message);
  }
}, 30000);

/***********************
 * DASHBOARD
 ***********************/
app.get('/', (req, res) => {
  res.send(`
    <h2>Silver Prime Bot</h2>
    <p>Price: ₹${lastKnownLtp}</p>
    <p>Position: ${botState.positionType || 'NONE'}</p>
    <p>Entry: ₹${botState.entryPrice}</p>
    <p>SL: ₹${botState.currentStop}</p>
    <p>Total PnL: ₹${botState.totalPnL}</p>
  `);
});

/***********************
 * MANUAL SYNC
 ***********************/
app.post('/sync-price', async (req, res) => {
  try {
    const pos = await axios.get(
      'https://api.upstox.com/v2/portfolio/short-term-positions',
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const p = pos.data.data.find(x => x.instrument_token === INSTRUMENT_KEY);
    if (p) {
      botState.positionType = p.quantity > 0 ? 'LONG' : 'SHORT';
      botState.quantity = Math.abs(p.quantity);
      botState.entryPrice = parseFloat(p.buy_price);
      botState.currentStop =
        botState.positionType === 'LONG'
          ? botState.entryPrice - 800
          : botState.entryPrice + 800;

      await placeSL(botState.currentStop, botState.positionType);
      await saveState();
    }
  } catch (e) {
    console.warn("Manual sync failed:", e.message);
  }
  res.redirect('/');
});

/***********************
 * SERVER
 ***********************/
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot running on ${PORT}`));

/***********************
 * AUTO LOGIN CRON
 ***********************/
setInterval(() => {
  if (!ACCESS_TOKEN) performAutoLogin();
}, 60000);
