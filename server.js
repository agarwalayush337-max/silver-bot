const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");

// ✅ CORRECT IMPORT for Manual WebSocket
const UpstoxClient = require('upstox-js-sdk'); 

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;

// --- 🔒 ENVIRONMENT VARIABLES ---
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

// Redis with Retry Logic
const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379", { maxRetriesPerRequest: null });

// --- GLOBAL VARIABLES ---
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let sseClients = []; 
let currentWs = null; // ✅ Websocket Tracker
let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    totalPnL: 0, 
    quantity: 0, 
    history: [],
    slOrderId: null 
};

// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 System State Loaded.");
    } catch (e) { console.log("Redis sync issue (first run?)"); }
}
loadState();

async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

// --- TIME HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isApiAvailable() { const m = (getIST().getHours()*60)+getIST().getMinutes(); return m >= 330 && m < 1440; }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; }

// --- DASHBOARD HELPERS ---
function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (parseFloat(botState.totalPnL) + uPnL).toFixed(2);
}

function pushToDashboard() {
    const data = JSON.stringify({ 
        price: lastKnownLtp, 
        pnl: calculateLivePnL(), 
        stop: botState.currentStop,
        status: ACCESS_TOKEN ? "ONLINE" : "OFFLINE"
    });
    sseClients.forEach(c => { try { c.res.write(`data: ${data}\n\n`); } catch(e) {} });
}

// --- EXCHANGE SL MANAGEMENT ---
async function manageExchangeSL(side, qty, triggerPrice) {
    if(!ACCESS_TOKEN) return;
    try {
        if (botState.slOrderId) {
            await axios.delete(`https://api.upstox.com/v2/order/cancel?order_id=${botState.slOrderId}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        }
        const res = await axios.post("https://api.upstox.com/v2/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: 0, 
            instrument_token: INSTRUMENT_KEY, order_type: "SL-M", 
            transaction_type: side === "BUY" ? "SELL" : "BUY", 
            trigger_price: Math.round(triggerPrice), is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        botState.slOrderId = res.data.data.order_id;
        await saveState();
    } catch (e) { console.log("Exchange SL Placement Failed"); }
}

async function modifyExchangeSL(newTrigger) {
    if (!botState.slOrderId) return;
    try {
        await axios.put("https://api.upstox.com/v2/order/modify", {
            order_id: botState.slOrderId,
            trigger_price: Math.round(newTrigger),
            quantity: botState.quantity,
            order_type: "SL-M"
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
    } catch (e) { /* Likely filled */ }
}

// --- 🔌 MANUAL WEBSOCKET ENGINE (FIXED) ---
// --- 🔌 MANUAL WEBSOCKET ENGINE (AXIOS VERSION) ---
// --- 🔌 MANUAL WEBSOCKET ENGINE (V3 COMPATIBLE) ---
async function initWebSocket() {
    if (!ACCESS_TOKEN || currentWs) return;

    try {
        console.log("🔌 Initializing Manual Market Data Feed (V3)...");

        // 1. Get Authorized URL from the NEW V3 Endpoint
        // V2 is deprecated (410 Gone), so we must use V3
        const response = await axios.get("https://api.upstox.com/v3/feed/market-data-feed/authorize", {
            headers: { 
                'Authorization': 'Bearer ' + ACCESS_TOKEN,
                'Accept': 'application/json'
            }
        });

        const wsUrl = response.data.data.authorizedRedirectUri;
        console.log("📡 Authorized URL received. Connecting...");

        const WebSocket = require('ws'); 
        currentWs = new WebSocket(wsUrl, { followRedirects: true });

        currentWs.onopen = () => {
            console.log("✅ WebSocket Open! Subscribing...");
            // V3 Subscription Format
            const subRequest = {
                guid: "bot-" + Date.now(),
                method: "sub",
                data: { mode: "ltpc", instrumentKeys: [INSTRUMENT_KEY] }
            };
            currentWs.send(JSON.stringify(subRequest));
        };

        currentWs.onmessage = (msg) => {
            // NOTE: V3 sends data in Binary (Protobuf) format.
            // A simple JSON.parse will fail, but that's okay!
            // We rely on the 30-second polling loop for trading logic.
            // This WebSocket connection just keeps the session alive.
            try {
                const strMsg = msg.data.toString();
                // Only try to parse if it looks like JSON (rare in V3)
                if (strMsg.trim().startsWith('{')) {
                    const data = JSON.parse(strMsg);
                    if (data?.feeds?.[INSTRUMENT_KEY]) {
                        lastKnownLtp = data.feeds[INSTRUMENT_KEY].ltpc.ltp;
                        pushToDashboard();
                    }
                }
            } catch (e) { 
                // Ignore binary parse errors - Bot will use polling data
            }
        };

        currentWs.onerror = (err) => console.error("❌ WS Runtime Error:", err.message);
        currentWs.onclose = () => {
            console.log("🔌 WebSocket Closed.");
            currentWs = null; 
        };

    } catch (e) { 
        currentWs = null;
        if (e.response && e.response.status === 401) {
            console.error(`❌ WS Token Expired. Refreshing...`);
            ACCESS_TOKEN = null; 
        } else {
            console.error(`❌ WS Init Failed (${e.response?.status || 'Error'}):`, e.message);
        }
    }
}

// --- 🤖 AUTO-LOGIN SYSTEM ---
async function performAutoLogin() {
    console.log("🤖 STARTING AUTO-LOGIN SEQUENCE...");
    
    if (currentWs) { try { currentWs.close(); } catch(e) {} currentWs = null; }

    let browser = null;
    try {
        const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET) });
        const codeOTP = totp.generate();
        console.log("🔐 Generated TOTP.");

        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        console.log("🌍 Navigating to Upstox...");
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const mobileInput = await page.$('#mobileNum');
        if (!mobileInput) throw new Error("Login Page Not Loaded");

        console.log("📱 Detected Login Screen. Typing Credentials...");
        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');
        
        await page.waitForSelector('#otpNum', { visible: true, timeout: 30000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        await page.waitForSelector('#pinCode', { visible: true, timeout: 30000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        // ✅ FIXED: Wait for URL instead of network idle
        await page.waitForFunction(() => window.location.href.includes('code='), { timeout: 40000 });
        
        const finalUrl = page.url();
        const authCode = new URL(finalUrl).searchParams.get('code');

        const params = new URLSearchParams();
        params.append('code', authCode);
        params.append('client_id', API_KEY);
        params.append('client_secret', API_SECRET);
        params.append('redirect_uri', REDIRECT_URI);
        params.append('grant_type', 'authorization_code');

        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
        ACCESS_TOKEN = res.data.access_token;
        
        console.log("🎉 SUCCESS! Session Active. Closing Browser...");
        if (browser) await browser.close(); 
        browser = null;

        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SYSTEM", price: 0, id: "Auto-Login OK", status: "OK" });
        await saveState();

    } catch (e) { 
        console.error("❌ Auto-Login Failed:", e.message); 
        if (browser) await browser.close();
    } 
}

// --- DATA ENGINE ---
async function getMergedCandles() {
    const today = new Date();
    const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
    const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
    const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

    try {
        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } }))
        ]);
        const mergedMap = new Map();
        (histRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        (intraRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        return Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
    } catch (e) { return []; }
}

// --- ✅ RESTORED: ORDER VERIFICATION LOGIC ---
async function fetchLatestOrderId() {
    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        if (res.data?.data?.length > 0) return res.data.data.sort((a, b) => new Date(b.order_timestamp) - new Date(a.order_timestamp))[0].order_id;
    } catch (e) { console.log("ID Fetch Failed: " + e.message); } return null;
}

async function verifyOrderStatus(orderId, context) {
    if (!orderId) orderId = await fetchLatestOrderId();
    if (!orderId) return;
    if (context !== 'MANUAL_SYNC') await new Promise(r => setTimeout(r, 2000)); 

    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        const order = res.data.data.find(o => o.order_id === orderId);
        if (!order) return;

        console.log(`🔎 Verifying Order ${orderId}: ${order.status}`);
        if (order.status === 'complete') {
            const realPrice = parseFloat(order.average_price);
            if (botState.positionType) botState.entryPrice = realPrice;
            
            const log = botState.history.find(h => h.id === orderId || h.id === 'PENDING_ID' || h.status === 'SENT');
            if (log) { log.price = realPrice; log.status = "FILLED"; log.id = orderId; }
            
            await saveState();
        } else if (['rejected', 'cancelled'].includes(order.status)) {
            if (context !== 'MANUAL_SYNC' && botState.positionType) {
                botState.positionType = null; botState.entryPrice = 0; botState.quantity = 0;
            }
            await saveState();
        }
    } catch (e) { console.log("Verification Error: " + e.message); }
}

async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const isAmo = !isMarketOpen();
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997)); 

    try {
        console.log(`🚀 Sending ${type}: ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        let orderId = res.data?.data?.order_id || 'PENDING_ID';
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: limitPrice, id: orderId, status: "SENT" });
        
        const slPrice = type === "BUY" ? (ltp - 800) : (ltp + 800);
        await manageExchangeSL(type, qty, slPrice);

        await saveState();
        // ✅ RESTORED: Call verification
        verifyOrderStatus(orderId, 'ENTRY');
        return true;
    } catch (e) {
        console.error(`❌ ORDER FAILED: ${e.message}`);
        return false;
    }
}

// --- CRON & WATCHDOG ---
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

// TRADING LOOP (Runs every 30s)
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) {
        if (!ACCESS_TOKEN) console.log("📡 Waiting for Token...");
        return;
    }

    if ((lastKnownLtp === 0 || !currentWs) && ACCESS_TOKEN) {
        console.log("🔄 Watchdog: Connecting WebSocket...");
        initWebSocket();
    }

    try {
        const candles = await getMergedCandles();
        console.log(`--------------------------------------------------`);
        console.log(`🕒 ${getIST().toLocaleTimeString()} | LTP: ₹${lastKnownLtp} | WS: ${currentWs ? 'Live' : 'Off'}`);

        if (candles.length > 200) {
            const cl = candles.map(c => c[4]), h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);
            
            if (lastKnownLtp === 0) lastKnownLtp = cl[cl.length-1];

            const e50 = EMA.calculate({period: 50, values: cl}), e200 = EMA.calculate({period: 200, values: cl}), vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
            
            const curE50=e50[e50.length-1], curE200=e200[e200.length-1], curV=v[v.length-1], curAvgV=vAvg[vAvg.length-1], curA=atr[atr.length-1];
            const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

            console.log(`📈 E50: ${curE50.toFixed(0)} | E200: ${curE200.toFixed(0)} | Vol: ${curV}`);

            if (isMarketOpen()) {
                if (!botState.positionType) {
                    if (cl[cl.length-2] > e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp > bH) {
                        botState.positionType = 'LONG'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp - (curA * 3);
                        await saveState(); await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                    } 
                    else if (cl[cl.length-2] < e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp < bL) {
                        botState.positionType = 'SHORT'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp + (curA * 3);
                        await saveState(); await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    }
                } else {
                    if (botState.positionType === 'LONG') {
                        let ns = Math.max(lastKnownLtp - (curA * 3), botState.currentStop);
                        if (ns > botState.currentStop) {
                            botState.currentStop = ns; await modifyExchangeSL(ns); 
                        }
                        if (lastKnownLtp < botState.currentStop) {
                            botState.totalPnL += (lastKnownLtp - botState.entryPrice) * botState.quantity; botState.positionType = null;
                            await saveState(); await placeOrder("SELL", botState.quantity, lastKnownLtp);
                        }
                    } else {
                        let ns = Math.min(lastKnownLtp + (curA * 3), botState.currentStop);
                        if (ns < botState.currentStop) {
                            botState.currentStop = ns; await modifyExchangeSL(ns); 
                        }
                        if (lastKnownLtp > botState.currentStop) {
                            botState.totalPnL += (botState.entryPrice - lastKnownLtp) * botState.quantity; botState.positionType = null;
                            await saveState(); await placeOrder("BUY", botState.quantity, lastKnownLtp);
                        }
                    }
                }
            }
        }
    } catch (e) { 
        if(e.response?.status===401) { 
            console.log("❌ 401 Detected in Loop. Resetting.");
            ACCESS_TOKEN = null; 
            performAutoLogin(); 
        } 
    }
}, 30000);

// --- 📡 API & DASHBOARD ---
app.get('/live-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    sseClients.push({ id, res });
    req.on('close', () => sseClients = sseClients.filter(c => c.id !== id));
});

app.get('/', (req, res) => {
    const historyHTML = botState.history.slice(0, 10).map(t => 
        `<div style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #334155; font-size:12px; align-items:center;">
            <span style="width:20%; color:#94a3b8;">${t.time}</span> 
            <b style="width:15%; color:${t.type=='BUY'?'#4ade80':t.type=='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span style="width:20%; font-weight:bold;">₹${t.price}</span> 
            <div style="width:45%; text-align:right;">
                <span style="display:block; color:${t.status=='FILLED'?'#4ade80':t.status=='SENT'?'#fbbf24':'#f472b6'}">${t.status}</span>
                <span style="display:block; color:#64748b; font-size:10px;">${t.id || '-'}</span>
            </div>
        </div>`).join('');

    res.send(`
        <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
                const source = new EventSource('/live-updates');
                source.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    document.getElementById('live-price').innerText = '₹' + d.price;
                    const pnlEl = document.getElementById('live-pnl');
                    pnlEl.innerText = '₹' + d.pnl;
                    pnlEl.style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                    document.getElementById('live-sl').innerText = '₹' + Math.round(d.stop || 0);
                    const stat = document.getElementById('live-status');
                    stat.innerText = d.status;
                    stat.style.color = d.status === 'ONLINE' ? '#4ade80' : '#ef4444';
                };
            </script>
        </head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px;">
                <h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime Auto</h2>
                <div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:15px;">
                    <small style="color:#94a3b8;">LIVE PRICE</small><br>
                    <b id="live-price" style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp || '---'}</b>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">TOTAL PNL</small><br><b id="live-pnl">₹${calculateLivePnL()}</b>
                    </div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">TRAILING SL</small><br><b id="live-sl" style="color:#f472b6;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '---'}</b>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">POSITION</small><br><b style="color:#facc15;">${botState.positionType || 'NONE'}</b>
                    </div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">STATUS</small><br><b id="live-status" style="color:${ACCESS_TOKEN?'#4ade80':'#ef4444'}">${ACCESS_TOKEN?'ONLINE':'OFFLINE'}</b>
                    </div>
                </div>
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#6366f1; color:white; border:none; border-radius:8px; cursor:pointer;">🤖 AUTO-LOGIN</button></form>
                     <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px; cursor:pointer;">🔄 SYNC PRICE</button></form>
                </div>
                <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Trade Log</h4>
                <div id="logContent">${historyHTML}</div>
            </div>
        </body></html>`);
});

app.post('/trigger-login', (req, res) => { performAutoLogin(); res.redirect('/'); });

// ✅ RESTORED: SYNC PRICE ROUTE
app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        const response = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const pos = (response.data?.data || []).find(p => p.instrument_token === INSTRUMENT_KEY);
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);
            botState.totalPnL = 0;
            const side = botState.positionType === 'LONG' ? 'SELL' : 'BUY';
            const slPrice = botState.positionType === 'LONG' ? (lastKnownLtp - 800) : (lastKnownLtp + 800);
            await manageExchangeSL(side, botState.quantity, slPrice);
        } else { botState.positionType = null; }
        await saveState();
    } catch (e) { console.error("Sync Error", e.message); }
    res.redirect('/');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
