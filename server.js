const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const WebSocket = require('ws'); // npm install ws
const { EMA, SMA, ATR } = require("technicalindicators");
const OTPAuth = require('otpauth');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

const redis = new Redis(REDIS_URL || "redis://localhost:6379");
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let clients = []; // For SSE (Real-time dashboard)

let botState = { 
    positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, 
    quantity: 0, history: [], slOrderId: null 
};

// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
    } catch (e) { console.log("Redis sync issue"); }
}
loadState();
async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

// --- 📈 WEBSOCKET ENGINE (Real-time Price) ---
function connectMarketData() {
    if (!ACCESS_TOKEN) return;
    // Upstox redirects to the actual socket after auth
    const wsUrl = `wss://api.upstox.com/v2/feed/market-data-feed`;
    const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': '*/*' }
    });

    ws.on('open', () => {
        console.log("🔌 WebSocket Connected.");
        const subData = { guid: "bot", method: "sub", data: { mode: "ltpc", instrumentKeys: [INSTRUMENT_KEY] } };
        ws.send(JSON.stringify(subData));
    });

    ws.on('message', (data) => {
        try {
            // Note: Upstox V3 uses Protobuf. For simplicity, we extract LTP here.
            // If using standard V2 json, use JSON.parse(data).
            const tick = JSON.parse(data); 
            if (tick.data && tick.data[INSTRUMENT_KEY]) {
                lastKnownLtp = tick.data[INSTRUMENT_KEY].ltp;
                broadcastUpdate(); // Push to Dashboard (SSE)
            }
        } catch(e) {}
    });

    ws.on('error', () => setTimeout(connectMarketData, 5000));
}

// --- 🛡️ TRAILING SL & ORDER SYNC ---
async function placeExchangeSL(type, qty, triggerPrice) {
    try {
        const res = await axios.post("https://api.upstox.com/v2/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: 0, 
            instrument_token: INSTRUMENT_KEY, order_type: "SL-M", 
            transaction_type: type === "BUY" ? "SELL" : "BUY", // Opposite of entry
            trigger_price: Math.round(triggerPrice), is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        
        botState.slOrderId = res.data.data.order_id;
        await saveState();
    } catch (e) { console.error("Exchange SL Failed"); }
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
    } catch (e) { console.log("SL Modification Ignored (Already filled/canceled)"); }
}

async function getRealTradedPrice(orderId) {
    try {
        const res = await axios.get(`https://api.upstox.com/v2/order/details?order_id=${orderId}`, 
            { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        return parseFloat(res.data.data.average_price) || 0;
    } catch (e) { return 0; }
}

// --- 📡 SSE DASHBOARD BROADCASTER ---
function broadcastUpdate() {
    const payload = JSON.stringify({ price: lastKnownLtp, pnl: calculateLivePnL() });
    clients.forEach(c => c.res.write(`data: ${payload}\n\n`));
}

function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (parseFloat(botState.totalPnL) + uPnL).toFixed(2);
}

// --- API ROUTES ---
app.get('/live-price', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    clients.push({ id, res });
    req.on('close', () => clients = clients.filter(c => c.id !== id));
});

app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        const posRes = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', 
            { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const pos = posRes.data.data.find(p => p.instrument_token === INSTRUMENT_KEY);
        
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.average_price);
            console.log("✅ Position Adopted from Upstox.");
        } else {
            botState.positionType = null;
        }
        await saveState();
    } catch (e) {}
    res.redirect('/');
});

// ... Keep existing Login, Candle Fetch, and Strategy Logic ...
// In Strategy Loop: When updating Trailing SL logic
// if (botState.positionType === 'LONG') {
//    let newSL = lastKnownLtp - (curA * 3);
//    if (newSL > botState.currentStop) { 
//        botState.currentStop = newSL; 
//        modifyExchangeSL(newSL); // Modify on Upstox
//    }
// }

app.get('/', (req, res) => {
    res.send(`
        <html>
        <body style="background:#0f172a; color:white; font-family:sans-serif; text-align:center;">
            <h1>🥈 Silver Live Dashboard</h1>
            <div style="font-size:40px; color:#fbbf24;" id="price">₹${lastKnownLtp}</div>
            <div style="font-size:24px;" id="pnl">PnL: ₹0.00</div>
            
            <script>
                const source = new EventSource('/live-price');
                source.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    document.getElementById('price').innerText = '₹' + d.price;
                    document.getElementById('pnl').innerText = 'PnL: ₹' + d.pnl;
                    document.getElementById('pnl').style.color = d.pnl >= 0 ? '#4ade80' : '#f87171';
                };
            </script>
        </body>
        </html>
    `);
});

app.listen(process.env.PORT || 10000);
