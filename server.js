const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server); // WebSocket for real-time dashboard
app.use(express.urlencoded({ extended: true }));

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;

const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;
const redis = new Redis(REDIS_URL || "redis://localhost:6379");

let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    totalPnL: 0, 
    quantity: 0, 
    history: [], 
    pnlHistory: [] // New: For Historical PnL Dashboard
};

// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 System State Loaded.");
    } catch (e) { console.log("Initial run, creating state..."); }
}
loadState();
async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

// --- TIME HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isMarketOpen() { 
    const t = getIST(); 
    const m = (t.getHours()*60)+t.getMinutes(); 
    return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; 
}

// --- AUTO-LOGIN SYSTEM (Puppeteer) ---
async function performAutoLogin() {
    console.log("🤖 STARTING AUTO-LOGIN...");
    let browser = null;
    try {
        const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET) });
        const codeOTP = totp.generate();
        browser = await puppeteer.launch({
    // Path where our build script extracts Chrome
    executablePath: '/opt/render/project/src/render-chrome/opt/google/chrome/google-chrome',
    headless: "new",
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
    ]
});
        const page = await browser.newPage();
        const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        await page.goto(loginUrl);
        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');
        await page.waitForSelector('#otpNum');
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');
        await page.waitForSelector('#pinCode');
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');
        await page.waitForNavigation();
        const authCode = new URL(page.url()).searchParams.get('code');
        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', new URLSearchParams({
            code: authCode, client_id: API_KEY, client_secret: API_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
        }));
        ACCESS_TOKEN = res.data.access_token;
        console.log("🎉 Session Active.");
    } catch (e) { console.error("❌ Login Failed:", e.message); } 
    finally { if (browser) await browser.close(); }
}

// --- ORDER EXECUTION WITH TRAILING STOP LOSS ---
async function placeOrderWithTSL(type, qty, ltp, stopPrice) {
    if (!ACCESS_TOKEN) return;
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997));
    
    try {
        // 1. Place Main Entry Order (V3)
        const entryRes = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: !isMarketOpen()
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = entryRes.data.data.order_id;
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: ltp, id: orderId, status: "SENT" });

        // 2. Place Trailing GTT Stop Loss (New Feature)
        const trailingGap = Math.abs(ltp - stopPrice);
        await axios.post("https://api.upstox.com/v3/gtt/place-order", {
            type: "SINGLE", instrument_token: INSTRUMENT_KEY, product: "I", quantity: qty,
            transaction_type: type === "BUY" ? "SELL" : "BUY",
            rules: [{
                strategy: "STOPLOSS", trigger_type: "IMMEDIATE", 
                trigger_price: stopPrice, trailing_gap: trailingGap
            }]
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});

        await saveState();
    } catch (e) { console.error("Order/TSL Failed:", e.response?.data || e.message); }
}

async function verifyOrderStatus(orderId) {
    try {
        const res = await axios.get(`https://api.upstox.com/v2/order/details?order_id=${orderId}`, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });
        const order = res.data.data;
        if (order.status === 'complete') {
            const actualPrice = parseFloat(order.average_price);
            const log = botState.history.find(h => h.id === orderId);
            if (log) { log.price = actualPrice; log.status = "FILLED"; }
            if (botState.positionType) botState.entryPrice = actualPrice;
            await saveState();
        }
    } catch (e) {}
}

// --- ENGINE & REAL-TIME SOCKETS ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isMarketOpen()) return;
    try {
        const res = await axios.get(`https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(INSTRUMENT_KEY)}`, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });
        lastKnownLtp = res.data.data[INSTRUMENT_KEY].last_price;
        
        // Push to Dashboard via WebSocket (Efficient)
        io.emit('priceUpdate', { price: lastKnownLtp, pnl: calculateLivePnL() });
    } catch (e) {}
}, 2000);

function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (botState.totalPnL + uPnL).toFixed(2);
}

// --- DASHBOARD WITH HISTORICAL PNL ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            socket.on('priceUpdate', (data) => {
                document.getElementById('live-price').innerText = '₹' + data.price;
                document.getElementById('live-pnl').innerText = '₹' + data.pnl;
            });
        </script>
        <body style="background:#0f172a; color:white; font-family:sans-serif; display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px;">
                <h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime Pro</h2>
                <div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:15px;">
                    <small>REAL-TIME PRICE</small><br><b id="live-price" style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp}</b>
                </div>
                <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px; margin-bottom:15px;">
                    <small>TOTAL PNL (LIVE)</small><br><b id="live-pnl">₹${calculateLivePnL()}</b>
                </div>
                <div style="margin-bottom:20px;">
                    <form action="/sync-price" method="POST"><button style="width:100%; padding:10px; background:#fbbf24; border:none; border-radius:8px;">🔄 SYNC MANUAL TRADES</button></form>
                </div>
                <h4 style="color:#94a3b8;">PnL History</h4>
                <div style="font-size:12px; max-height:100px; overflow-y:auto; border:1px solid #334155; padding:5px;">
                    ${botState.pnlHistory.map(p => `<div>${p.date}: ₹${p.amount}</div>`).join('') || 'No records.'}
                </div>
                <h4 style="color:#94a3b8;">Recent Trades</h4>
                ${botState.history.slice(0,5).map(h => `<div style="font-size:11px; border-bottom:1px solid #334155; padding:5px;">${h.time} | ${h.type} | ₹${h.price} | ${h.status}</div>`).join('')}
            </div>
        </body></html>
    `);
});

app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        const posRes = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });
        const pos = (posRes.data.data || []).find(p => p.instrument_token === INSTRUMENT_KEY);
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);
            botState.currentStop = botState.positionType === 'LONG' ? lastKnownLtp - 800 : lastKnownLtp + 800;
            console.log("✅ Manual position synced.");
        } else {
            // If position is closed, move today's PnL to history
            if (botState.positionType) {
                botState.pnlHistory.unshift({ date: getIST().toLocaleDateString(), amount: calculateLivePnL() });
            }
            botState.positionType = null;
        }
        await saveState();
    } catch (e) { console.error("Sync Error", e.message); }
    res.redirect('/');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Bot Running on Port ${PORT}`));
