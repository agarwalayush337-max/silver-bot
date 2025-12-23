const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- ⚙️ CONFIGURATION & CONSTANTS ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;
const STRATEGY_NAME = "Silver-Prime-V6";

// --- 🔒 ENVIRONMENT VARIABLES ---
const { 
    UPSTOX_USER_ID, 
    UPSTOX_PIN, 
    UPSTOX_TOTP_SECRET, 
    API_KEY, 
    API_SECRET, 
    REDIRECT_URI, 
    REDIS_URL 
} = process.env;

// Connect to Redis with Error Handling
const redis = new Redis(REDIS_URL || "redis://localhost:6379");
redis.on("error", (err) => console.error("❌ Redis Connection Error:", err));

let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    totalPnL: 0, 
    quantity: 0, 
    history: [] 
};

// --- 📂 STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) {
            botState = JSON.parse(saved);
            console.log("📂 State successfully synchronized from Redis.");
        } else {
            console.log("🆕 No previous state found. Initializing fresh.");
        }
    } catch (e) {
        console.error("❌ Failed to load state from Redis:", e.message);
    }
}
loadState();

async function saveState() {
    try {
        await redis.set('silver_bot_state', JSON.stringify(botState));
    } catch (e) {
        console.error("❌ Redis Save Error:", e.message);
    }
}

// --- 🕒 TIME & CALENDAR HELPERS ---
function getIST() {
    return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function isApiAvailable() {
    const now = getIST();
    const minutes = (now.getHours() * 60) + now.getMinutes();
    return minutes >= 330 && minutes < 1440; // 5:30 AM to Midnight
}

function isMarketOpen() {
    const t = getIST();
    const minutes = (t.getHours() * 60) + t.getMinutes();
    const day = t.getDay();
    const isWeekday = day !== 0 && day !== 6;
    const isTradingHours = minutes >= 540 && minutes < 1430; // 9:00 AM to 11:50 PM
    return isWeekday && isTradingHours;
}

// --- 🤖 THE AUTO-LOGIN ENGINE ---
async function performAutoLogin() {
    console.log("-----------------------------------------");
    console.log("🤖 STARTING FULL AUTO-LOGIN SEQUENCE...");
    let browser = null;
    try {
        const totp = new OTPAuth.TOTP({ 
            algorithm: 'SHA1', 
            digits: 6, 
            period: 30, 
            secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET) 
        });
        const codeOTP = totp.generate();
        console.log(`🔐 Step 1: TOTP Generated [${codeOTP}]`);

        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        console.log("🌍 Step 2: Navigating to Upstox Login Page...");
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

        console.log("📱 Step 3: Submitting Mobile Number...");
        await page.waitForSelector('#mobileNum', { timeout: 15000 });
        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');

        console.log("🔢 Step 4: Submitting OTP...");
        await page.waitForSelector('#otpNum', { visible: true, timeout: 15000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        console.log("🔒 Step 5: Submitting Secure PIN...");
        await page.waitForSelector('#pinCode', { visible: true, timeout: 15000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        console.log("⏳ Step 6: Waiting for Authorization Code Redirect...");
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        
        const finalUrl = page.url();
        const urlParams = new URL(finalUrl).searchParams;
        const authCode = urlParams.get('code');

        if (!authCode) throw new Error("Redirected but no Auth Code found in URL");
        console.log("✅ Step 7: Auth Code Captured successfully.");

        console.log("🔄 Step 8: Exchanging Code for Access Token...");
        const tokenParams = new URLSearchParams();
        tokenParams.append('code', authCode);
        tokenParams.append('client_id', API_KEY);
        tokenParams.append('client_secret', API_SECRET);
        tokenParams.append('redirect_uri', REDIRECT_URI);
        tokenParams.append('grant_type', 'authorization_code');

        const response = await axios.post('https://api.upstox.com/v2/login/authorization/token', tokenParams, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        ACCESS_TOKEN = response.data.access_token;
        console.log("🎉 SUCCESS! Bot is now Authenticated and Online.");
        console.log("-----------------------------------------");
        
        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type: "SYSTEM", 
            price: 0, 
            id: "LOGIN_SUCCESS", 
            status: "OK" 
        });
        await saveState();

    } catch (err) {
        console.error("❌ AUTO-LOGIN CRITICAL FAILURE:", err.message);
    } finally {
        if (browser) await browser.close();
    }
}

// --- 📈 DATA ACQUISITION & MERGING ---
async function getMergedCandles() {
    const today = new Date();
    const lookback = new Date();
    lookback.setDate(today.getDate() - 8);
    
    const intradayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
    const historicalUrl = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${formatDate(today)}/${formatDate(lookback)}`;

    try {
        const headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' };
        const [histResponse, intraResponse] = await Promise.all([
            axios.get(historicalUrl, { headers }).catch(() => ({ data: { data: { candles: [] } } })),
            axios.get(intradayUrl, { headers }).catch(() => ({ data: { data: { candles: [] } } }))
        ]);

        const mergedMap = new Map();
        const histCandles = histResponse.data?.data?.candles || [];
        const intraCandles = intraResponse.data?.data?.candles || [];

        histCandles.forEach(c => mergedMap.set(c[0], c));
        intraCandles.forEach(c => mergedMap.set(c[0], c));

        const finalData = Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
        return finalData;
    } catch (e) {
        console.error("❌ Data Fetch Error:", e.message);
        return [];
    }
}

// --- 📑 ORDER VERIFICATION ENGINE ---
async function fetchLatestOrderId() {
    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });
        const orders = res.data?.data || [];
        if (orders.length > 0) {
            return orders.sort((a, b) => new Date(b.order_timestamp) - new Date(a.order_timestamp))[0].order_id;
        }
    } catch (e) { console.error("❌ Order ID Fetch Failed"); }
    return null;
}

async function verifyOrderStatus(orderId, context = 'AUTO') {
    if (!orderId) orderId = await fetchLatestOrderId();
    if (!orderId) return;

    if (context !== 'MANUAL_SYNC') await new Promise(r => setTimeout(r, 2500));

    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });
        const orders = res.data?.data || [];
        const order = orders.find(o => o.order_id === orderId);

        if (order && order.status === 'complete') {
            const avgPrice = parseFloat(order.average_price);
            console.log(`✅ Order ${orderId} CONFIRMED FILLED at ₹${avgPrice}`);
            
            if (botState.positionType && context !== 'EXIT') botState.entryPrice = avgPrice;
            
            const logEntry = botState.history.find(h => h.id === orderId || h.id === 'PENDING_ID');
            if (logEntry) {
                logEntry.price = avgPrice;
                logEntry.status = "FILLED";
                logEntry.id = orderId;
            }
            await saveState();
        } else if (order && ['rejected', 'cancelled'].includes(order.status)) {
            console.error(`❌ Order ${orderId} was ${order.status.toUpperCase()}`);
            if (context === 'ENTRY') {
                botState.positionType = null;
                botState.entryPrice = 0;
            }
            await saveState();
        }
    } catch (e) { console.error("❌ Verification Exception:", e.message); }
}

// --- 🛒 PLACEMENT ENGINE ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    
    // Calculate Limit Price with 0.3% slippage protection
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997));
    const isAmo = !isMarketOpen();

    try {
        const orderPayload = {
            quantity: qty,
            product: "I", // Intraday
            validity: "DAY",
            price: limitPrice,
            instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT",
            transaction_type: type,
            disclosed_quantity: 0,
            trigger_price: 0,
            is_amo: isAmo
        };

        const res = await axios.post("https://api.upstox.com/v3/order/place", orderPayload, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });

        const orderId = res.data?.data?.order_id || 'PENDING_ID';
        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type: type, 
            price: limitPrice, 
            id: orderId, 
            status: "SENT" 
        });
        
        await saveState();
        const context = (botState.positionType) ? 'ENTRY' : 'EXIT';
        verifyOrderStatus(orderId, context);
        return true;
    } catch (e) {
        const errMsg = e.response?.data?.errors?.[0]?.message || e.message;
        console.error("❌ ORDER PLACEMENT ERROR:", errMsg);
        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type: "ERROR", 
            price: ltp, 
            id: "REJECTED", 
            status: errMsg 
        });
        await saveState();
        return false;
    }
}

// --- ⚡ REAL-TIME QUOTE ENGINE (Every 1.5s) ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isMarketOpen()) return;
    try {
        const quoteUrl = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(INSTRUMENT_KEY)}`;
        const res = await axios.get(quoteUrl, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });
        const ltp = res.data?.data?.[INSTRUMENT_KEY]?.last_price;
        if (ltp) lastKnownLtp = ltp;
    } catch (e) {}
}, 1500);

// --- 🤖 MAIN STRATEGY ENGINE (Every 30s) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) {
        console.log("📡 System Status: Waiting for Authentication Token...");
        return;
    }

    try {
        const candles = await getMergedCandles();
        if (candles.length < 200) {
            console.log(`💓 Heartbeat: Data loading (${candles.length}/200 candles found).`);
            return;
        }

        const cl = candles.map(c => c[4]);
        const h = candles.map(c => c[2]);
        const l = candles.map(c => c[3]);
        const v = candles.map(c => c[5]);
        
        lastKnownLtp = cl[cl.length - 1];

        // 📐 Calculate Indicators
        const e50Arr = EMA.calculate({ period: 50, values: cl });
        const e200Arr = EMA.calculate({ period: 200, values: cl });
        const vAvgArr = SMA.calculate({ period: 20, values: v });
        const atrArr = ATR.calculate({ high: h, low: l, close: cl, period: 14 });

        const curE50 = e50Arr[e50Arr.length - 1];
        const curE200 = e200Arr[e200Arr.length - 1];
        const curATR = atrArr[atrArr.length - 1];
        
        // Strategy Setup (Using Previous Candle Index)
        const pi = cl.length - 2; 
        const prevVol = v[pi];
        const avgVol = vAvgArr[vAvgArr.length - 2];
        const prevE50 = e50Arr[e50Arr.length - 2];
        const prevE200 = e200Arr[e200Arr.length - 2];

        // 🛡️ Safety Breakout Levels
        const breakoutHigh = Math.max(...h.slice(-11, -1));
        const breakoutLow = Math.min(...l.slice(-11, -1));

        // 📝 VERBOSE LOGGING
        const logTime = getIST().toLocaleTimeString();
        console.log(`[${logTime}] P:₹${lastKnownLtp} | EMA 50/200: ${curE50.toFixed(0)}/${curE200.toFixed(0)} | Vol: ${prevVol}/${(avgVol * 1.5).toFixed(0)} | Open: ${isMarketOpen()}`);

        if (isMarketOpen()) {
            if (!botState.positionType) {
                // --- ENTRY LOGIC ---
                const isBullish = prevE50 > prevE200 && prevVol > (avgVol * 1.5) && lastKnownLtp > breakoutHigh;
                const isBearish = prevE50 < prevE200 && prevVol > (avgVol * 1.5) && lastKnownLtp < breakoutLow;

                if (isBullish) {
                    console.log("⚡ ENTRY SIGNAL: LONG BREAKOUT DETECTED");
                    botState.positionType = 'LONG';
                    botState.entryPrice = lastKnownLtp;
                    botState.quantity = MAX_QUANTITY;
                    botState.currentStop = lastKnownLtp - (curATR * 3);
                    await saveState();
                    await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                } else if (isBearish) {
                    console.log("⚡ ENTRY SIGNAL: SHORT BREAKOUT DETECTED");
                    botState.positionType = 'SHORT';
                    botState.entryPrice = lastKnownLtp;
                    botState.quantity = MAX_QUANTITY;
                    botState.currentStop = lastKnownLtp + (curATR * 3);
                    await saveState();
                    await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                }
            } else {
                // --- EXIT LOGIC (Trailing Stop) ---
                if (botState.positionType === 'LONG') {
                    const newStop = lastKnownLtp - (curATR * 3);
                    if (newStop > botState.currentStop) botState.currentStop = newStop;
                    
                    if (lastKnownLtp < botState.currentStop) {
                        console.log("🛑 EXIT SIGNAL: LONG TRAILING STOP HIT");
                        botState.totalPnL += (lastKnownLtp - botState.entryPrice) * botState.quantity;
                        botState.positionType = null;
                        await saveState();
                        await placeOrder("SELL", botState.quantity, lastKnownLtp);
                    }
                } else {
                    const newStop = lastKnownLtp + (curATR * 3);
                    if (newStop < botState.currentStop) botState.currentStop = newStop;

                    if (lastKnownLtp > botState.currentStop) {
                        console.log("🛑 EXIT SIGNAL: SHORT TRAILING STOP HIT");
                        botState.totalPnL += (botState.entryPrice - lastKnownLtp) * botState.quantity;
                        botState.positionType = null;
                        await saveState();
                        await placeOrder("BUY", botState.quantity, lastKnownLtp);
                    }
                }
            }
        }
    } catch (e) {
        if (e.response?.status === 401) {
            console.error("🔑 Token expired. Re-triggering Login...");
            ACCESS_TOKEN = null;
            performAutoLogin();
        }
    }
}, 30000);

// --- 🌐 WEB DASHBOARD & AJAX API ---
function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (botState.totalPnL + uPnL).toFixed(2);
}

app.get('/price', (req, res) => {
    res.json({ 
        price: lastKnownLtp, 
        pnl: calculateLivePnL(), 
        stop: botState.currentStop ? botState.currentStop.toFixed(0) : '---',
        pos: botState.positionType || 'NONE'
    });
});

app.get('/', (req, res) => {
    const historyRows = botState.history.slice(0, 10).map(t => `
        <div style="display:flex; justify-content:space-between; padding:12px; border-bottom:1px solid #334155; font-size:12px; align-items:center;">
            <span style="width:20%; color:#94a3b8;">${t.time}</span> 
            <b style="width:15%; color:${t.type==='BUY'?'#4ade80':t.type==='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span style="width:20%; font-weight:bold;">₹${t.price}</span> 
            <div style="width:45%; text-align:right;">
                <span style="color:#4ade80; font-weight:bold;">${t.status}</span><br>
                <small style="color:#64748b; font-size:10px;">${t.id}</small>
            </div>
        </div>
    `).join('');

    res.send(`
    <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
    <head>
        <title>Silver Prime v6</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script>
            function update() {
                fetch('/price?cache=' + Date.now()).then(r => r.json()).then(d => {
                    document.getElementById('ltp').innerText = '₹' + d.price;
                    const pnlBox = document.getElementById('pnl');
                    pnlBox.innerText = '₹' + d.pnl;
                    pnlBox.style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                    document.getElementById('sl').innerText = '₹' + d.stop;
                    document.getElementById('pos').innerText = d.pos;
                    document.getElementById('pulse').style.opacity = '1';
                    setTimeout(() => document.getElementById('pulse').style.opacity = '0.2', 300);
                }).catch(() => { document.getElementById('api-status').innerText = 'RECONNECTING...'; });
            }
            setInterval(update, 1000);
        </script>
    </head>
    <body style="display:flex; justify-content:center; padding:20px;">
        <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:20px; box-shadow:0 15px 35px rgba(0,0,0,0.6);">
            <h2 style="color:#38bdf8; text-align:center; margin-bottom:20px; letter-spacing:1px;">
                🥈 SILVER PRIME <span id="pulse" style="color:#4ade80; transition:0.3s;">●</span>
            </h2>
            
            <div style="text-align:center; padding:20px; background:#0f172a; border-radius:15px; margin-bottom:20px; border:1px solid #334155;">
                <small style="color:#94a3b8; letter-spacing:1px;">LIVE MARKET PRICE</small><br>
                <b id="ltp" style="font-size:36px; color:#fbbf24;">₹${lastKnownLtp}</b>
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:20px;">
                <div style="background:#0f172a; padding:15px; text-align:center; border-radius:12px; border:1px solid #334155;">
                    <small style="color:#94a3b8;">TOTAL P&L</small><br>
                    <b id="pnl" style="font-size:20px;">₹${calculateLivePnL()}</b>
                </div>
                <div style="background:#0f172a; padding:15px; text-align:center; border-radius:12px; border:1px solid #334155;">
                    <small style="color:#94a3b8;">TRAIL SL</small><br>
                    <b id="sl" style="color:#f472b6; font-size:20px;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '---'}</b>
                </div>
            </div>

            <div style="display:flex; gap:12px; margin-bottom:25px;">
                <div style="flex:1; background:#0f172a; padding:12px; text-align:center; border-radius:10px;">
                    <small style="color:#94a3b8;">POSITION</small><br><b id="pos" style="color:#facc15;">${botState.positionType || 'NONE'}</b>
                </div>
                <div style="flex:1; background:#0f172a; padding:12px; text-align:center; border-radius:10px;">
                     <small style="color:#94a3b8;">API STATUS</small><br><b id="api-status" style="color:#4ade80;">${ACCESS_TOKEN ? 'ONLINE' : 'OFFLINE'}</b>
                </div>
            </div>

            <div style="display:flex; gap:12px; margin-bottom:25px;">
                 <form action="/login" method="POST" style="flex:1;"><button style="width:100%; padding:14px; background:#6366f1; color:white; border:none; border-radius:10px; font-weight:bold; cursor:pointer;">FORCE LOGIN</button></form>
                 <form action="/sync" method="POST" style="flex:1;"><button style="width:100%; padding:14px; background:#fbbf24; color:#0f172a; border:none; border-radius:10px; font-weight:bold; cursor:pointer;">SYNC ORDERS</button></form>
            </div>

            <h4 style="color:#94a3b8; border-bottom:1px solid #334155; padding-bottom:10px; margin-bottom:10px;">Execution History</h4>
            <div style="max-height:300px; overflow-y:auto;">
                ${historyRows || '<p style="text-align:center; color:#64748b; padding:20px;">Waiting for first trade signal...</p>'}
            </div>
        </div>
    </body></html>
    `);
});

app.post('/login', (req, res) => { performAutoLogin(); res.redirect('/'); });
app.post('/sync', async (req, res) => { await verifyOrderStatus(null, 'MANUAL_SYNC'); res.redirect('/'); });

// Daily Cron Job for Auto-Login at 8:30 AM IST
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log("=========================================");
    console.log(`🚀 SILVER BOT SERVER LIVE ON PORT ${PORT}`);
    console.log(`📅 Current IST: ${getIST().toLocaleString()}`);
    console.log("=========================================");
});
