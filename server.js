const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIG ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const STATE_FILE = './bot_state.json';
const MAX_QUANTITY = 1; 

// --- STATE PERSISTENCE ---
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0 };
if (fs.existsSync(STATE_FILE)) botState = JSON.parse(fs.readFileSync(STATE_FILE));
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }

// --- MARKET HOUR CHECKER ---
function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    return totalMin >= 525 && totalMin < 1439; // 8:45 AM to 11:59 PM
}

// --- ORDER EXECUTION (AMO & REGULATORY COMPLIANT) ---
async function placeOrder(type, qty, currentLtp) {
    if (!ACCESS_TOKEN) return false;

    const isAmo = !isMarketOpen();
    
    // October 2025 Regulation: Use LIMIT with 1% buffer instead of MARKET
    const buffer = currentLtp * 0.01; 
    const limitPrice = type === "BUY" ? (currentLtp + buffer) : (currentLtp - buffer);

    const orderData = {
        quantity: qty,
        product: "I",
        validity: "DAY",
        price: Math.round(limitPrice * 20) / 20, // Round to nearest 0.05 tick
        instrument_token: INSTRUMENT_KEY,
        order_type: "LIMIT", // 👈 Regulatory compliant
        transaction_type: type,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: isAmo // 👈 Enables testing while market is closed
    };

    try {
        const res = await axios.post("https://api.upstox.com/v3/order/place", orderData, {
            headers: { 
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ ${isAmo ? 'AMO ' : ''}${type} Success! Price: ${limitPrice.toFixed(2)} | ID: ${res.data.data.order_id}`);
        return true;
    } catch (e) {
        console.error(`❌ Order Error: ${e.response?.data?.errors[0]?.message || e.message}`);
        return false;
    }
}

// --- MANUAL TEST ROUTE ---
app.get('/test-amo', async (req, res) => {
    if (!ACCESS_TOKEN) return res.send("Token missing! Paste token on home page first.");
    
    console.log("🛠️ Manual AMO Ping Test Triggered...");
    // Mocking an LTP of 75000 for the test
    const success = await placeOrder("BUY", 1, 75000);
    
    if (success) {
        res.send("<h1>✅ AMO Ping Successful!</h1><p>Check your Upstox App 'Orders' tab. You should see a pending Silver Micro order. <b>Cancel it manually now!</b></p>");
    } else {
        res.send("<h1>❌ AMO Ping Failed</h1><p>Check your console/logs for the error message.</p>");
    }
});

// --- MAIN TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isMarketOpen()) return;

    try {
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const candles = res.data.data.candles.reverse();
        const c = candles.map(cand => cand[4]);
        const lastC = c[c.length-1];
        
        // ... (Insert Indicator Calculations here from previous version)

        // Logic uses placeOrder(type, qty, lastC)
    } catch (e) { console.log("Engine Error"); }
}, 30000);

app.get('/', (req, res) => { /* Dashboard HTML code from previous version */ });
app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });

app.listen(process.env.PORT || 3000);
