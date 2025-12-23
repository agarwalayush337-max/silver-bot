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

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let sseClients = []; 

let botState = { 
    positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, 
    quantity: 0, history: [], slOrderId: null 
};

// --- STATE & HELPERS ---
async function loadState() {
    const saved = await redis.get('silver_bot_state');
    if (saved) botState = JSON.parse(saved);
    console.log("📂 System State Loaded.");
}
loadState();
async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; }

// --- 📈 WEBSOCKET ENGINE ---
async function initWebSocket() {
    if (!ACCESS_TOKEN) return;
    try {
        const streamer = new MarketDataStreamerV3();
        await streamer.connect(ACCESS_TOKEN);
        streamer.subscribe([INSTRUMENT_KEY], 'ltpc');
        streamer.on('data', (data) => {
            if (data && data[INSTRUMENT_KEY]) {
                lastKnownLtp = data[INSTRUMENT_KEY].ltp;
                console.log(`Live Price: ${lastKnownLtp}`); // Restored Console Log
                pushToDashboard();
            }
        });
    } catch (e) { console.log("WebSocket Connection Error"); }
}

function pushToDashboard() {
    const data = JSON.stringify({ price: lastKnownLtp, pnl: calculateLivePnL(), stop: botState.currentStop });
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

// --- 🛡️ EXCHANGE SL ORDER LOGIC ---
async function manageExchangeSL(side, qty, triggerPrice) {
    try {
        // Cancel old SL if exists
        if (botState.slOrderId) {
            await axios.delete(`https://api.upstox.com/v2/order/cancel?order_id=${botState.slOrderId}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        }
        // Place new SL-M (Opposite side of entry)
        const res = await axios.post("https://api.upstox.com/v2/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: 0, 
            instrument_token: INSTRUMENT_KEY, order_type: "SL-M", 
            transaction_type: side === "BUY" ? "SELL" : "BUY", 
            trigger_price: Math.round(triggerPrice), is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        
        botState.slOrderId = res.data.data.order_id;
        await saveState();
    } catch (e) { console.log("Exchange SL Failed"); }
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
    } catch (e) { /* Order likely already triggered */ }
}

// ... [Keep your performAutoLogin and Strategy logic as before] ...

// --- 📡 SSE FOR REAL-TIME DASHBOARD ---
app.get('/live-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    sseClients.push({ id, res });
    req.on('close', () => sseClients = sseClients.filter(c => c.id !== id));
});

// --- 📊 RESTORED DASHBOARD HTML (BASED ON SCREENSHOT) ---
app.get('/', (req, res) => {
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
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
                // ⚡ SSE Real-time Listener
                const source = new EventSource('/live-updates');
                source.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    document.getElementById('live-price').innerText = '₹' + d.price;
                    document.getElementById('live-pnl').innerText = '₹' + d.pnl;
                    document.getElementById('live-pnl').parentElement.style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                    document.getElementById('live-sl').innerText = '₹' + Math.round(d.stop || 0);
                };
            </script>
        </head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
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
                <div id="logContent">${historyHTML || '<p style="text-align:center; color:#64748b;">No trades yet.</p>'}</div>
            </div>
        </body></html>
    `);
});

app.listen(process.env.PORT || 10000);
