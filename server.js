const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;

// --- 🔒 ENVIRONMENT VARIABLES ---
// Ensure these are set in Render!
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

// Connect to Database
const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379");

let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

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
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 525 && m < 1439; }

// --- 🤖 AUTO-LOGIN SYSTEM (Do Not Remove) ---
async function performAutoLogin() {
    console.log("🤖 STARTING AUTO-LOGIN SEQUENCE...");
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

        // Check for Mobile Number Field
        const mobileInput = await page.$('#mobileNum');
        if (!mobileInput) {
            const pageText = await page.evaluate(() => document.body.innerText); 
            console.error("📄 PAGE CONTENT:", pageText);
            throw new Error("Login Page Not Loaded (Check API Key/Redirect URI)");
        }

        console.log("📱 Detected Login Screen. Typing Credentials...");
        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');

        console.log("🔢 Entering TOTP...");
        await page.waitForSelector('#otpNum', { visible: true, timeout: 30000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        console.log("🔒 Entering PIN...");
        await page.waitForSelector('#pinCode', { visible: true, timeout: 30000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        console.log("⏳ Waiting for Auth Code...");
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        
        const finalUrl = page.url();
        const authCode = new URL(finalUrl).searchParams.get('code');
        if (!authCode) throw new Error("No Auth Code in URL after redirect");

        // Exchange Code for Token
        const params = new URLSearchParams();
        params.append('code', authCode);
        params.append('client_id', API_KEY);
        params.append('client_secret', API_SECRET);
        params.append('redirect_uri', REDIRECT_URI);
        params.append('grant_type', 'authorization_code');

        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
        ACCESS_TOKEN = res.data.access_token;
        console.log("🎉 SUCCESS! Session Active.");
        
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SYSTEM", price: 0, id: "Auto-Login OK", status: "OK" });
        await saveState();

    } catch (e) { console.error("❌ Auto-Login Failed:", e.message); } 
    finally { if (browser) await browser.close(); }
}

// --- DATA ENGINE ---
async function getMergedCandles() {
    const today = new Date();
    const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
    // Fetch last 10 days + Intraday data
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
        // Sort by Time
        return Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
    } catch (e) { return []; }
}

// --- ORDER EXECUTION & SYNC ---
async function fetchLatestOrderId() {
    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        if (res.data?.data?.length > 0) return res.data.data.sort((a, b) => new Date(b.order_timestamp) - new Date(a.order_timestamp))[0].order_id;
    } catch (e) { console.log("ID Fetch Failed: " + e.message); } return null;
}

async function verifyOrderStatus(orderId, context) {
    if (!orderId) orderId = await fetchLatestOrderId();
    if (!orderId) return;
    if (context !== 'MANUAL_SYNC') await new Promise(r => setTimeout(r, 2000)); // Wait for broker to process

    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        const order = res.data.data.find(o => o.order_id === orderId);
        if (!order) return;

        console.log(`🔎 Verifying Order ${orderId}: ${order.status}`);
        if (order.status === 'complete') {
            const realPrice = parseFloat(order.average_price);
            if (botState.positionType) botState.entryPrice = realPrice;
            
            // Update History Log with Real Price and Order ID
            if (context === 'MANUAL_SYNC' && botState.history.length > 0) {
                 botState.history[0].price = realPrice; botState.history[0].status = "FILLED"; botState.history[0].id = orderId;
            } else {
                const log = botState.history.find(h => h.id === orderId || h.id === 'PENDING_ID' || h.status === 'SENT');
                if (log) { log.price = realPrice; log.status = "FILLED"; log.id = orderId; }
            }
            await saveState();
        } else if (['rejected', 'cancelled'].includes(order.status)) {
            // If entry failed, reset position
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
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997)); // 0.3% Buffer for Limit Order

    try {
        console.log(`🚀 Sending ${type}: ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        let orderId = res.data?.data?.order_id || 'PENDING_ID';
        // Log "SENT" immediately
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: limitPrice, id: orderId, status: "SENT" });
        await saveState();

        // Check verification context
        const context = (type === 'BUY' && botState.positionType === 'LONG') || (type === 'SELL' && botState.positionType === 'SHORT') ? 'ENTRY' : 'EXIT';
        verifyOrderStatus(orderId, context);
        return true;
    } catch (e) {
        const err = e.response?.data?.errors?.[0]?.message || e.message;
        console.error(`❌ ORDER FAILED: ${err}`);
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "ERROR", price: limitPrice, id: err, status: "FAILED" });
        await saveState();
        return false;
    }
}

// --- CRON JOBS ---
// 1. Auto-Login daily at 8:30 AM IST
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

// 2. Trading Loop (Runs every 30 seconds)
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) { console.log(!ACCESS_TOKEN ? "📡 Waiting for Token..." : "😴 Market Closed / API Sleeping"); return; }
    
    try {
        const candles = await getMergedCandles();
        if (candles.length > 200) {
            // Arrays for Indicators
            const cl = candles.map(c => c[4]);
            const h = candles.map(c => c[2]);
            const l = candles.map(c => c[3]);
            const v = candles.map(c => c[5]);

            lastKnownLtp = cl[cl.length-1]; // Live Price

            if (isMarketOpen()) {
                // Calculate Indicators
                const e50 = EMA.calculate({period: 50, values: cl});
                const e200 = EMA.calculate({period: 200, values: cl});
                const vAvg = SMA.calculate({period: 20, values: v});
                const atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
                
                // --- STRATEGY INDICES ---
                // We use Index -2 (Previous Closed Candle) for setup to be safe
                const idx = cl.length - 2; 
                
                const prevE50 = e50[idx];
                const prevE200 = e200[idx];
                const prevVol = v[idx];
                const prevAvgVol = vAvg[idx];
                const curA = atr[atr.length-1];
                
                // Breakout Levels (High/Low of last 10 candles, excluding current)
                const bH = Math.max(...h.slice(-11, -1));
                const bL = Math.min(...l.slice(-11, -1));

                console.log(`📊 P:₹${lastKnownLtp} | Trend:${prevE50>prevE200?'UP':'DOWN'} | Vol:${prevVol} (Avg:${prevAvgVol.toFixed(0)})`);

                if (!botState.positionType) {
                    // --- ENTRY LOGIC ---
                    // 1. Trend Filter: EMA 50 > EMA 200 (using closed candle)
                    // 2. Volume Filter: Last Closed Vol > 1.5x Avg Vol
                    // 3. Trigger: LIVE Price breaks 10-candle High
                    
                    if (prevE50 > prevE200 && prevVol > (prevAvgVol * 1.5) && lastKnownLtp > bH) {
                        console.log("⚡ LONG SIGNAL DETECTED");
                        botState.positionType = 'LONG'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; 
                        botState.currentStop = lastKnownLtp - (curA * 3);
                        await saveState(); await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                    } 
                    else if (prevE50 < prevE200 && prevVol > (prevAvgVol * 1.5) && lastKnownLtp < bL) {
                        console.log("⚡ SHORT SIGNAL DETECTED");
                        botState.positionType = 'SHORT'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; 
                        botState.currentStop = lastKnownLtp + (curA * 3);
                        await saveState(); await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    }
                } else {
                    // --- EXIT LOGIC (Trailing SL) ---
                    if (botState.positionType === 'LONG') {
                        botState.currentStop = Math.max(lastKnownLtp - (curA * 3), botState.currentStop);
                        if (lastKnownLtp < botState.currentStop) {
                            console.log("🛑 TRAILING STOP HIT (LONG)");
                            botState.totalPnL += (lastKnownLtp - botState.entryPrice) * botState.quantity; 
                            botState.positionType = null;
                            await saveState(); await placeOrder("SELL", botState.quantity, lastKnownLtp);
                        }
                    } else {
                        botState.currentStop = Math.min(lastKnownLtp + (curA * 3), botState.currentStop || 999999);
                        if (lastKnownLtp > botState.currentStop) {
                            console.log("🛑 TRAILING STOP HIT (SHORT)");
                            botState.totalPnL += (botState.entryPrice - lastKnownLtp) * botState.quantity; 
                            botState.positionType = null;
                            await saveState(); await placeOrder("BUY", botState.quantity, lastKnownLtp);
                        }
                    }
                }
            }
        }
    } catch (e) { 
        if(e.response?.status===401) { ACCESS_TOKEN = null; performAutoLogin(); } // Auto-recover if token dies
    }
}, 30000);

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    let uPnL = 0;
    // Calculate Unrealized PnL
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    const totalPnL = botState.totalPnL + uPnL;

    // Generate Trade Log HTML
    let historyHTML = botState.history.slice(0, 10).map(t => 
        `<div style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #334155; font-size:12px; align-items:center;">
            <span style="width:20%; color:#94a3b8;">${t.time}</span> 
            <b style="width:15%; color:${t.type=='BUY'?'#4ade80':t.type=='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span style="width:20%; font-weight:bold;">₹${t.price}</span> 
            <div style="width:45%; text-align:right;">
                <span style="display:block; color:${t.status=='FILLED'?'#4ade80':t.status=='SENT'?'#fbbf24':'#f472b6'}">${t.status}</span>
                <span style="display:block; color:#64748b; font-size:10px;">${t.id || '-'}</span>
            </div>
        </div>`
    ).join('');

    res.send(`
        <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30"></head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
                <h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime Auto</h2>
                
                <div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:15px;">
                    <small style="color:#94a3b8;">LIVE PRICE</small><br><b style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp || '---'}</b>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">TOTAL PNL</small><br><b style="color:${totalPnL>=0?'#4ade80':'#f87171'}">₹${totalPnL.toFixed(2)}</b>
                    </div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">TRAILING SL</small><br><b style="color:#f472b6;">${botState.currentStop ? '₹'+botState.currentStop.toFixed(0) : '---'}</b>
                    </div>
                </div>

                <div style="display:flex; gap:10px; margin-bottom:20px;">
                    <div style="flex:1; background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">POSITION</small><br><b style="color:#facc15;">${botState.positionType || 'NONE'}</b>
                    </div>
                    <div style="flex:1; background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                         <small style="color:#94a3b8;">STATUS</small><br><b style="color:${ACCESS_TOKEN?'#4ade80':'#ef4444'}">${ACCESS_TOKEN?'ONLINE':'OFFLINE'}</b>
                    </div>
                </div>

                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#6366f1; color:white; border:none; border-radius:8px; cursor:pointer;">🤖 AUTO-LOGIN</button></form>
                     <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px; cursor:pointer;">🔄 SYNC PRICE</button></form>
                </div>

                <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Trade Log</h4>
                ${historyHTML || '<p style="text-align:center; color:#64748b;">No trades yet.</p>'}
            </div>
        </body></html>
    `);
});

app.post('/trigger-login', (req, res) => { performAutoLogin(); res.redirect('/'); });
app.post('/sync-price', async (req, res) => { if(ACCESS_TOKEN) await verifyOrderStatus(null, 'MANUAL_SYNC'); res.redirect('/'); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot Live on ${PORT}`));
