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
// UPSTOX_USER_ID = Your Mobile Number
// UPSTOX_PIN = Your 6-Digit PIN
// UPSTOX_TOTP_SECRET = Your TOTP Secret
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379");
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

// --- STATE & HELPERS ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
    } catch (e) { console.log("Redis sync issue."); }
}
loadState();

async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isApiAvailable() { const m = (getIST().getHours()*60)+getIST().getMinutes(); return m >= 330 && m < 1440; }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 525 && m < 1439; }

// --- 🤖 AUTO-LOGIN (MOBILE + TOTP) ---
// --- 🤖 ROBUST AUTO-LOGIN (Mobile + User ID Support) ---
async function performAutoLogin() {
    console.log("🤖 STARTING AUTO-LOGIN...");
    let browser = null;

    try {
        // 1. Generate TOTP
        const totp = new OTPAuth.TOTP({
            algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET)
        });
        const codeOTP = totp.generate();
        console.log("🔐 Generated TOTP.");

        // 2. Launch Browser (Stealth Mode)
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled' // 🕵️‍♂️ Hides that this is a bot
            ]
        });
        const page = await browser.newPage();
        
        // Set User Agent (Looks like a real Mac/Windows user)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 3. Go to Login (Wait up to 60s)
        const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        console.log("🌍 Navigating to Upstox...");
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // 🔍 DIAGNOSTIC: Where are we?
        const pageTitle = await page.title();
        console.log(`👀 Page Loaded: "${pageTitle}"`);

        // 4. SMART SELECTOR: Check for Mobile OR User ID field
        // We race two promises to see which field appears first
        const mobileField = await page.waitForSelector('#mobileNum', { timeout: 10000 }).catch(() => null);
        const userField = await page.waitForSelector('#userId', { timeout: 1000 }).catch(() => null);

        if (mobileField) {
            console.log("📱 Detected Mobile Login Screen.");
            await page.type('#mobileNum', UPSTOX_USER_ID);
            await page.click('#getOtp');
        } 
        else if (userField) {
            console.log("👤 Detected User ID Login Screen (Unexpected but handling it).");
            await page.type('#userId', UPSTOX_USER_ID); // Hope UPSTOX_USER_ID is mobile/user compatible
            // Note: If you are here, the flow might be different, but usually it defaults to Mobile.
        } 
        else {
            // If neither found, print HTML for debugging
            throw new Error(`Login fields not found! Page Title: ${pageTitle}`);
        }

        // 5. Enter TOTP (Waiting for OTP field)
        console.log("🔢 Waiting for OTP field...");
        await page.waitForSelector('#otpNum', { visible: true, timeout: 30000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        // 6. Enter PIN
        console.log("🔒 Entering PIN...");
        await page.waitForSelector('#pinCode', { visible: true, timeout: 30000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        // 7. Capture Auth Code
        console.log("⏳ Waiting for Redirect...");
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        
        const finalUrl = page.url();
        if (!finalUrl.includes('code=')) {
            console.log("⚠️ URL at failure: " + finalUrl);
            throw new Error("Redirected but no Auth Code found!");
        }
        
        const authCode = new URL(finalUrl).searchParams.get('code');

        // 8. Exchange for Token
        console.log("🔄 Exchanging Code for Token...");
        const params = new URLSearchParams();
        params.append('code', authCode);
        params.append('client_id', API_KEY);
        params.append('client_secret', API_SECRET);
        params.append('redirect_uri', REDIRECT_URI);
        params.append('grant_type', 'authorization_code');

        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, {
             headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        ACCESS_TOKEN = res.data.access_token;
        console.log("🎉 SUCCESS! Bot is Live.");
        
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SYSTEM", price: 0, id: "Auto-Login OK", status: "OK" });
        await saveState();

    } catch (e) {
        console.error("❌ Auto-Login Failed:", e.message);
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "ERROR", price: 0, id: "Login Failed", status: "FAILED" });
    } finally {
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

// --- ORDER & SYNC ---
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

        console.log(`🔎 Order ${orderId}: ${order.status}`);
        if (order.status === 'complete') {
            const realPrice = parseFloat(order.average_price);
            if (botState.positionType) botState.entryPrice = realPrice;
            
            if (context === 'MANUAL_SYNC' && botState.history.length > 0) {
                 botState.history[0].price = realPrice; botState.history[0].status = "FILLED"; botState.history[0].id = orderId;
            } else {
                const log = botState.history.find(h => h.id === orderId || h.id === 'PENDING_ID' || h.status === 'SENT');
                if (log) { log.price = realPrice; log.status = "FILLED"; log.id = orderId; }
            }
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
        console.log(`🚀 ${type} ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        let orderId = res.data?.data?.order_id || 'PENDING_ID';
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: limitPrice, id: orderId, status: "SENT" });
        await saveState();

        const context = (type === 'BUY' && botState.positionType === 'LONG') || (type === 'SELL' && botState.positionType === 'SHORT') ? 'ENTRY' : 'EXIT';
        verifyOrderStatus(orderId, context);
        return true;
    } catch (e) {
        const err = e.response?.data?.errors?.[0]?.message || e.message;
        console.error(`❌ FAILED: ${err}`);
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "ERROR", price: limitPrice, id: err, status: "FAILED" });
        await saveState();
        return false;
    }
}

// --- CRON & ENGINE ---
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) { console.log(!ACCESS_TOKEN ? "📡 Waiting for Token..." : "😴 API Sleeping..."); return; }
    try {
        const candles = await getMergedCandles();
        if (candles.length > 200) {
            const cl = candles.map(c => c[4]);
            lastKnownLtp = cl[cl.length-1];

            if (isMarketOpen()) {
                const h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);
                const e50 = EMA.calculate({period: 50, values: cl}), e200 = EMA.calculate({period: 200, values: cl});
                const vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
                
                const curE50=e50[e50.length-1], curE200=e200[e200.length-1], lastV=v[v.length-1], curV=vAvg[vAvg.length-1], lastC=lastKnownLtp, curA=atr[atr.length-1];
                const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

                console.log(`📊 P:${lastC} | E50:${curE50.toFixed(0)} | V:${lastV}`);

                if (!botState.positionType) {
                    if (curE50 > curE200 && lastV > (curV * 1.5) && lastC > bH) {
                        botState.positionType = 'LONG'; botState.entryPrice = lastC; botState.quantity = MAX_QUANTITY; botState.currentStop = lastC - (curA * 3);
                        await saveState(); await placeOrder("BUY", MAX_QUANTITY, lastC);
                    } else if (curE50 < curE200 && lastV > (curV * 1.5) && lastC < bL) {
                        botState.positionType = 'SHORT'; botState.entryPrice = lastC; botState.quantity = MAX_QUANTITY; botState.currentStop = lastC + (curA * 3);
                        await saveState(); await placeOrder("SELL", MAX_QUANTITY, lastC);
                    }
                } else {
                    if (botState.positionType === 'LONG') {
                        botState.currentStop = Math.max(lastC - (curA * 3), botState.currentStop);
                        if (lastC < botState.currentStop) {
                            botState.totalPnL += (lastC - botState.entryPrice) * botState.quantity; botState.positionType = null;
                            await saveState(); await placeOrder("SELL", botState.quantity, lastC);
                        }
                    } else {
                        botState.currentStop = Math.min(lastC + (curA * 3), botState.currentStop || 999999);
                        if (lastC > botState.currentStop) {
                            botState.totalPnL += (botState.entryPrice - lastC) * botState.quantity; botState.positionType = null;
                            await saveState(); await placeOrder("BUY", botState.quantity, lastC);
                        }
                    }
                }
            }
        }
    } catch (e) { 
        if(e.response?.status===401) { ACCESS_TOKEN = null; performAutoLogin(); } // Auto-Retry Login on 401
    }
}, 30000);

// --- DASHBOARD ---
app.get('/', (req, res) => {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    const totalPnL = botState.totalPnL + uPnL;

    let historyHTML = botState.history.slice(0, 8).map(t => 
        `<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #334155; font-size:12px;">
            <span>${t.time}</span> <b style="color:${t.type=='BUY'?'#4ade80':t.type=='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span>₹${t.price}</span> <span>${t.status}</span>
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
                        <small style="color:#94a3b8;">STATUS</small><br><b style="color:${ACCESS_TOKEN?'#4ade80':'#ef4444'}">${ACCESS_TOKEN?'ONLINE':'OFFLINE'}</b>
                    </div>
                </div>
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#6366f1; color:white; border:none; border-radius:8px; cursor:pointer;">🤖 AUTO-LOGIN</button></form>
                     <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px; cursor:pointer;">🔄 SYNC PRICE</button></form>
                     <form action="/reset-state" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#ef4444; color:white; border:none; border-radius:8px; cursor:pointer;">⚠️ RESET</button></form>
                </div>
                <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Logs</h4>
                ${historyHTML}
            </div>
        </body></html>
    `);
});

app.post('/trigger-login', (req, res) => { performAutoLogin(); res.redirect('/'); });
app.post('/sync-price', async (req, res) => { if(ACCESS_TOKEN) await verifyOrderStatus(null, 'MANUAL_SYNC'); res.redirect('/'); });
app.post('/reset-state', async (req, res) => { botState = { ...botState, positionType: null, entryPrice: 0, quantity: 0 }; await saveState(); res.redirect('/'); });

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot Live on ${PORT}`));
