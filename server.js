const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- ⚙️ CONFIGURATION & CONSTANTS ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;
const PROTO_URL = "https://raw.githubusercontent.com/upstox/upstox-nodejs/master/lib/Protocol.proto";

// --- 🔒 ENVIRONMENT VARIABLES ---
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379");
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

// --- 📂 STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) {
            botState = JSON.parse(saved);
            console.log("📂 System State Synchronized from Redis.");
        }
    } catch (e) { console.error("❌ Redis Load Error:", e.message); }
}
loadState();

async function saveState() {
    try {
        await redis.set('silver_bot_state', JSON.stringify(botState));
    } catch (e) { console.error("❌ Redis Save Error:", e.message); }
}

// --- 🕒 TIME HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isApiAvailable() { const m = (getIST().getHours()*60)+getIST().getMinutes(); return m >= 330 && m < 1440; }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; }

// --- 🤖 AUTO-LOGIN ENGINE (FULL VERSION) ---
async function performAutoLogin() {
    console.log("🤖 STARTING FULL AUTO-LOGIN SEQUENCE...");
    let browser = null;
    try {
        const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET) });
        const codeOTP = totp.generate();
        console.log("🔐 Generated TOTP.");

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        console.log("🌍 Navigating to Upstox...");
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');
        
        await page.waitForSelector('#otpNum', { visible: true, timeout: 30000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        await page.waitForSelector('#pinCode', { visible: true, timeout: 30000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        
        const finalUrl = page.url();
        const authCode = new URL(finalUrl).searchParams.get('code');
        if (!authCode) throw new Error("Auth Code Capture Failed");

        const params = new URLSearchParams();
        params.append('code', authCode); params.append('client_id', API_KEY); params.append('client_secret', API_SECRET);
        params.append('redirect_uri', REDIRECT_URI); params.append('grant_type', 'authorization_code');

        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
        ACCESS_TOKEN = res.data.access_token;
        console.log("🎉 SUCCESS! Session Active.");
        
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SYSTEM", price: 0, id: "LOGIN_OK", status: "OK" });
        await saveState();
        initWebSocket();

    } catch (e) { console.error("❌ Auto-Login Failed:", e.message); } 
    finally { if (browser) await browser.close(); }
}

// --- 🌐 PRO WEBSOCKET (REAL-TIME FEED) ---
let ws;
async function initWebSocket() {
    if (!ACCESS_TOKEN) return;
    try {
        const response = await axios.get('https://api.upstox.com/v2/feed/market-data-feed/authorize', {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });

        ws = new WebSocket(response.data.data.authorizedRedirectUri, { perMessageDeflate: false });

        ws.on('open', () => {
            const data = { guid: "guid", method: "sub", data: { mode: "full", instrumentKeys: [INSTRUMENT_KEY] } };
            ws.send(Buffer.from(JSON.stringify(data)));
        });

        const root = await protobuf.load(PROTO_URL);
        const FeedResponse = root.lookupType("com.upstox.marketdata.FeedResponse");

        ws.on('message', (data) => {
            try {
                const decoded = FeedResponse.decode(data);
                const feed = decoded.toJSON();
                if (feed.feeds && feed.feeds[INSTRUMENT_KEY]) {
                    const ltp = feed.feeds[INSTRUMENT_KEY].fullFeed.marketFF.ltpc.ltp;
                    if (ltp) lastKnownLtp = ltp;
                }
            } catch (e) {}
        });

        ws.on('close', () => { if (ACCESS_TOKEN) setTimeout(initWebSocket, 5000); });
        ws.on('error', (err) => { console.log("WebSocket Error:", err.message); });
    } catch (e) { console.error("WS Init Error"); }
}

// --- 📈 TRADING ENGINE (FULL LOGIC) ---
async function getMergedCandles() {
    const today = new Date();
    const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
    const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
    const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

    try {
        const headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' };
        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers }).catch(() => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers }).catch(() => ({ data: { data: { candles: [] } } }))
        ]);
        const mergedMap = new Map();
        (histRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        (intraRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        return Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
    } catch (e) { return []; }
}

async function verifyOrderStatus(orderId) {
    if (!orderId) return;
    await new Promise(r => setTimeout(r, 2000));
    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const order = res.data.data.find(o => o.order_id === orderId);
        if (order && order.status === 'complete') {
            const realPrice = parseFloat(order.average_price);
            if (botState.positionType) botState.entryPrice = realPrice;
            const log = botState.history.find(h => h.id === orderId || h.status === 'SENT');
            if (log) { log.price = realPrice; log.status = "FILLED"; }
            await saveState();
        }
    } catch (e) {}
}

async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997)); 
    try {
        console.log(`🚀 Sending ${type}: ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: !isMarketOpen()
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});
        
        const orderId = res.data.data.order_id;
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: limitPrice, id: orderId, status: "SENT" });
        await saveState();
        verifyOrderStatus(orderId);
        return true;
    } catch (e) { return false; }
}

// MAIN LOGIC LOOP (30s)
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) { console.log("📡 Waiting for Token / API Sleep..."); return; }
    try {
        const candles = await getMergedCandles();
        if (candles.length > 200) {
            const cl = candles.map(c => c[4]), h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);
            const e50Arr = EMA.calculate({period: 50, values: cl}), e200Arr = EMA.calculate({period: 200, values: cl});
            const vAvgArr = SMA.calculate({period: 20, values: v}), atrArr = ATR.calculate({high: h, low: l, close: cl, period: 14});
            
            const idx = cl.length - 2;
            const curE50 = e50Arr[e50Arr.length-1], curE200 = e200Arr[e200Arr.length-1], curA = atrArr[atrArr.length-1];
            const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

            console.log(`[${getIST().toLocaleTimeString()}] P:₹${lastKnownLtp} | EMA50:${curE50.toFixed(0)} | EMA200:${curE200.toFixed(0)} | MarketOpen:${isMarketOpen()}`);

            if (isMarketOpen()) {
                if (!botState.positionType) {
                    if (e50Arr[idx] > e200Arr[idx] && v[idx] > (vAvgArr[idx] * 1.5) && lastKnownLtp > bH) {
                        console.log("⚡ LONG SIGNAL");
                        botState.positionType = 'LONG'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp - (curA * 3);
                        await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                    } else if (e50Arr[idx] < e200Arr[idx] && v[idx] > (vAvgArr[idx] * 1.5) && lastKnownLtp < bL) {
                        console.log("⚡ SHORT SIGNAL");
                        botState.positionType = 'SHORT'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp + (curA * 3);
                        await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    }
                } else {
                    if (botState.positionType === 'LONG') {
                        botState.currentStop = Math.max(lastKnownLtp - (curA * 3), botState.currentStop);
                        if (lastKnownLtp < botState.currentStop) {
                            botState.totalPnL += (lastKnownLtp - botState.entryPrice) * MAX_QUANTITY; botState.positionType = null;
                            await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                        }
                    } else {
                        botState.currentStop = Math.min(lastKnownLtp + (curA * 3), botState.currentStop || 999999);
                        if (lastKnownLtp > botState.currentStop) {
                            botState.totalPnL += (botState.entryPrice - lastKnownLtp) * MAX_QUANTITY; botState.positionType = null;
                            await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                        }
                    }
                }
                await saveState();
            }
        }
    } catch (e) { if(e.response?.status===401) { ACCESS_TOKEN = null; performAutoLogin(); } }
}, 30000);

// --- 🌐 WEB DASHBOARD ---
function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * MAX_QUANTITY;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * MAX_QUANTITY;
    return (botState.totalPnL + uPnL).toFixed(2);
}

app.get('/price', (req, res) => {
    res.json({ price: lastKnownLtp, pnl: calculateLivePnL(), sl: botState.currentStop ? botState.currentStop.toFixed(0) : '---' });
});

app.get('/', (req, res) => {
    let historyRows = botState.history.slice(0, 10).map(t => `
        <div style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #334155; font-size:12px;">
            <span style="width:20%; color:#94a3b8;">${t.time}</span> <b style="width:15%; color:${t.type==='BUY'?'#4ade80':'#f87171'}">${t.type}</b> 
            <span style="width:20%;">₹${t.price}</span> <div style="width:45%; text-align:right;"><span style="color:#4ade80">${t.status}</span><br><small style="font-size:9px; color:#64748b">${t.id}</small></div>
        </div>`).join('');

    res.send(`
        <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
                function update() {
                    fetch('/price?t=' + Date.now()).then(r => r.json()).then(d => {
                        document.getElementById('p').innerText = '₹' + d.price;
                        document.getElementById('n').innerText = '₹' + d.pnl;
                        document.getElementById('s').innerText = '₹' + d.sl;
                        document.getElementById('n').style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                    }).catch(() => {});
                }
                setInterval(update, 1000);
            </script>
        </head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
                <h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime WebSocket</h2>
                <div style="text-align:center; padding:15px; background:#0f172a; border-radius:10px; margin-bottom:15px; border:1px solid #334155;">
                    <small style="color:#94a3b8;">LIVE MARKET PRICE</small><br><b id="p" style="font-size:36px; color:#fbbf24;">₹${lastKnownLtp}</b>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:12px; text-align:center; border-radius:8px;"><small>TOTAL P&L</small><br><b id="n">₹${calculateLivePnL()}</b></div>
                    <div style="background:#0f172a; padding:12px; text-align:center; border-radius:8px;"><small>STOP LOSS</small><br><b id="s" style="color:#f472b6;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '---'}</b></div>
                </div>
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                    <div style="flex:1; background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small>POS</small><br><b style="color:#facc15;">${botState.positionType || 'NONE'}</b></div>
                    <div style="flex:1; background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small>API</small><br><b style="color:#4ade80;">${ACCESS_TOKEN ? 'ONLINE' : 'OFFLINE'}</b></div>
                </div>
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/login" method="POST" style="flex:1;"><button style="width:100%; padding:12px; background:#6366f1; color:white; border:none; border-radius:8px; font-weight:bold;">AUTO-LOGIN</button></form>
                </div>
                <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Execution History</h4>
                ${historyRows || '<p style="text-align:center; padding:10px;">Waiting for signals...</p>'}
            </div>
        </body></html>
    `);
});

app.post('/login', (req, res) => { performAutoLogin(); res.redirect('/'); });

// 8:30 AM Cron Job
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

app.listen(process.env.PORT || 10000, '0.0.0.0');
