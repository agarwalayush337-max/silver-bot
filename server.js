const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");
const { UpstoxClient, MarketDataStreamerV3 } = require('upstox-js-sdk'); // New SDK

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

const redis = new Redis(REDIS_URL);
let ACCESS_TOKEN = null;
let lastKnownLtp = 0;
let clients = []; // SSE Dashboard clients

let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    totalPnL: 0, 
    quantity: 0, 
    slOrderId: null 
};

// --- STATE MANAGEMENT ---
async function loadState() {
    const saved = await redis.get('silver_bot_state');
    if (saved) botState = JSON.parse(saved);
}
loadState();
async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

// --- 📈 WEBSOCKET REAL-TIME ENGINE ---
async function initWebSocket() {
    if (!ACCESS_TOKEN) return;
    const streamer = new MarketDataStreamerV3();
    const result = await streamer.connect(ACCESS_TOKEN);
    
    streamer.subscribe([INSTRUMENT_KEY], 'ltpc');
    
    streamer.on('data', (data) => {
        if (data && data[INSTRUMENT_KEY]) {
            lastKnownLtp = data[INSTRUMENT_KEY].ltp;
            broadcastToDashboard();
        }
    });
}

function broadcastToDashboard() {
    const pnl = calculateLivePnL();
    const data = JSON.stringify({ price: lastKnownLtp, pnl });
    clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

function calculateLivePnL() {
    let currentPnL = 0;
    if (botState.positionType === 'LONG') currentPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') currentPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (parseFloat(botState.totalPnL) + currentPnL).toFixed(2);
}

// --- 🛡️ ORDER & SL MANAGEMENT ---
async function placeOrder(side, qty, type = "MARKET", price = 0) {
    try {
        const res = await axios.post('https://api.upstox.com/v2/order/place', {
            quantity: qty, product: "I", validity: "DAY", price: price,
            instrument_token: INSTRUMENT_KEY, order_type: type,
            transaction_type: side, is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        return res.data.data.order_id;
    } catch (e) { console.error("Order Failed", e.response.data); }
}

async function manageExchangeSL(side, qty, triggerPrice) {
    // If old SL exists, cancel it first
    if (botState.slOrderId) {
        try { await axios.delete(`https://api.upstox.com/v2/order/cancel?order_id=${botState.slOrderId}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }}); } catch(e){}
    }
    // Place new SL-M Order
    botState.slOrderId = await placeOrder(side === "BUY" ? "SELL" : "BUY", qty, "SL-M", triggerPrice);
    await saveState();
}

async function modifyExchangeSL(newTrigger) {
    if (!botState.slOrderId) return;
    try {
        await axios.put('https://api.upstox.com/v2/order/modify', {
            order_id: botState.slOrderId,
            trigger_price: Math.round(newTrigger),
            quantity: botState.quantity,
            order_type: "SL-M"
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
    } catch (e) { console.log("SL Modification Failed - possibly already hit"); }
}

// --- 🧠 STRATEGY ENGINE (Runs every 30s) ---
async function runStrategy() {
    if (!ACCESS_TOKEN || lastKnownLtp === 0) return;

    // ... [Your existing Candle Fetch & Technical Indicator Logic (EMA, SMA, ATR)] ...
    // ... [Inside the Strategy logic where you check for Long/Short entries] ...

    if (longCondition && !botState.positionType) {
        const orderId = await placeOrder("BUY", MAX_QUANTITY);
        // Wait 1s for trade to settle then fetch actual price
        setTimeout(async () => {
            botState.entryPrice = lastKnownLtp; 
            botState.positionType = "LONG";
            botState.quantity = MAX_QUANTITY;
            const initialSL = lastKnownLtp - (atrValue * 3);
            botState.currentStop = initialSL;
            await manageExchangeSL("BUY", MAX_QUANTITY, initialSL);
            await saveState();
        }, 1000);
    }

    // Trailing Logic
    if (botState.positionType === 'LONG') {
        let trailSL = lastKnownLtp - (atrValue * 3);
        if (trailSL > botState.currentStop) {
            botState.currentStop = trailSL;
            await modifyExchangeSL(trailSL);
            await saveState();
        }
    }
}

// --- 📡 SSE ROUTE ---
app.get('/live-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    clients.push({ id, res });
    req.on('close', () => clients = clients.filter(c => c.id !== id));
});

// --- 🔄 POWER SYNC (Manual Trade Adoption) ---
app.post('/sync-price', async (req, res) => {
    try {
        const posRes = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const pos = posRes.data.data.find(p => p.instrument_token === INSTRUMENT_KEY);
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? "LONG" : "SHORT";
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.average_price);
            // Re-sync SL if needed
        } else {
            botState.positionType = null;
        }
        await saveState();
    } catch(e) { console.log("Sync Error"); }
    res.redirect('/');
});

// --- 📊 DASHBOARD HTML ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Silver Bot Live</title></head>
        <body style="background:#111; color:white; font-family:sans-serif; text-align:center;">
            <h1>Silver Prime Live</h1>
            <div id="price" style="font-size:3em; color:gold;">₹${lastKnownLtp}</div>
            <div id="pnl" style="font-size:2em;">PnL: ₹0.00</div>
            
            <h3>Trade History</h3>
            <table id="historyTable" border="1" style="margin:auto; width:80%">
                <tr><th>Time</th><th>Type</th><th>Price</th><th>Result</th></tr>
            </table>

            <script>
                const source = new EventSource('/live-updates');
                source.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    document.getElementById('price').innerText = '₹' + data.price;
                    document.getElementById('pnl').innerText = 'PnL: ₹' + data.pnl;
                    document.getElementById('pnl').style.color = data.pnl >= 0 ? '#4ade80' : '#f87171';
                };
            </script>
        </body>
        </html>
    `);
});

// Start Loops
setInterval(runStrategy, 30000); 
app.listen(process.env.PORT || 10000, () => console.log("Server Running"));
