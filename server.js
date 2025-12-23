const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");
const { MarketDataStreamerV3 } = require('upstox-js-sdk');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

// Initialize Redis with retry protection
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let sseClients = []; 

let botState = { 
    positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, 
    quantity: 0, history: [], slOrderId: null 
};

// --- 🛠️ HELPER FUNCTIONS (Placed first to avoid ReferenceErrors) ---

function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isApiAvailable() { const m = (getIST().getHours()*60)+getIST().getMinutes(); return m >= 330 && m < 1440; }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; }

function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (parseFloat(botState.totalPnL) + uPnL).toFixed(2);
}

function pushToDashboard() {
    const data = JSON.stringify({ price: lastKnownLtp, pnl: calculateLivePnL(), stop: botState.currentStop });
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 System State Loaded.");
    } catch (e) { console.log("Redis sync issue (first run?)"); }
}
loadState();

// --- 🛡️ ORDER & SL MANAGEMENT ---

async function manageExchangeSL(side, qty, triggerPrice) {
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

// ... [Include your existing performAutoLogin and Strategy Logic here] ...

// --- 📉 WEBSOCKET REAL-TIME ENGINE ---
async function initWebSocket() {
    if (!ACCESS_TOKEN) return;
    try {
        const streamer = new MarketDataStreamerV3();
        await streamer.connect(ACCESS_TOKEN);
        streamer.subscribe([INSTRUMENT_KEY], 'ltpc');
        streamer.on('data', (data) => {
            if (data && data[INSTRUMENT_KEY]) {
                lastKnownLtp = data[INSTRUMENT_KEY].ltp;
                console.log(`Live Price: ${lastKnownLtp}`);
                pushToDashboard();
            }
        });
    } catch (e) { console.error("WS Error:", e.message); }
}

// --- 📡 API ROUTES ---

app.get('/live-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    sseClients.push({ id, res });
    req.on('close', () => sseClients = sseClients.filter(c => c.id !== id));
});

app.get('/price', (req, res) => {
    res.json({ price: lastKnownLtp, pnl: calculateLivePnL() });
});

app.get('/', (req, res) => {
    let historyHTML = botState.history.slice(0, 10).map(t => 
        `<div style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #334155; font-size:12px;">
            <span style="color:#94a3b8;">${t.time}</span> 
            <b style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</b> 
            <b>₹${t.price}</b> 
            <span style="color:#fbbf24;">${t.status}</span>
        </div>`
    ).join('');

    res.send(`
        <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head>
            <script>
                const source = new EventSource('/live-updates');
                source.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    document.getElementById('live-price').innerText = '₹' + d.price;
                    const pnlEl = document.getElementById('live-pnl');
                    pnlEl.innerText = '₹' + d.pnl;
                    pnlEl.style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                    document.getElementById('live-sl').innerText = '₹' + Math.round(d.stop || 0);
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
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#6366f1; color:white; border:none; border-radius:8px;">🤖 AUTO-LOGIN</button></form>
                     <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px;">🔄 SYNC PRICE</button></form>
                </div>
                <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Trade Log</h4>
                <div>${historyHTML || '<p style="text-align:center; color:#64748b;">No trades yet.</p>'}</div>
            </div>
        </body></html>
    `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot Live on ${PORT}`));
