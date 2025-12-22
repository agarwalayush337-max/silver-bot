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

// --- PERSISTENCE ---
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0 };
if (fs.existsSync(STATE_FILE)) {
    try { botState = JSON.parse(fs.readFileSync(STATE_FILE)); } catch(e) { console.log("State file reset"); }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }

// --- TIMER (8:45 AM - 11:59 PM IST) ---
function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    return totalMin >= 525 && totalMin < 1439; 
}

// --- ORDERS (Regulatory Compliant LIMIT-MARKET) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN) return false;
    const isAmo = !isMarketOpen();
    const buffer = ltp * 0.01;
    const limitPrice = type === "BUY" ? (ltp + buffer) : (ltp - buffer);

    try {
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", 
            price: Math.round(limitPrice * 20) / 20,
            instrument_token: INSTRUMENT_KEY, order_type: "LIMIT",
            transaction_type: type, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});
        console.log(`✅ ${type} Order Placed: ID ${res.data.data.order_id}`);
        return true;
    } catch (e) {
        console.error(`❌ Order Error: ${e.response?.data?.errors[0]?.message || e.message}`);
        return false;
    }
}

// --- TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;
    if (!isMarketOpen()) {
        console.log("😴 Market Closed. Bot Idle.");
        return;
    }

    try {
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const candles = res.data.data.candles.reverse();
        const h = candles.map(c => c[2]), l = candles.map(c => c[3]), c = candles.map(c => c[4]), v = candles.map(c => c[5]);

        const e50 = EMA.calculate({period: 50, values: c}), e200 = EMA.calculate({period: 200, values: c});
        const vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: c, period: 14});

        const lastC = c[c.length-1], lastV = v[v.length-1], curE50 = e50[e50.length-1], curE200 = e200[e200.length-1], curV = vAvg[vAvg.length-1], curA = atr[atr.length-1];
        const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

        if (!botState.positionType) {
            if (curE50 > curE200 && lastV > (curV * 1.5) && lastC > bH) {
                if (await placeOrder("BUY", MAX_QUANTITY, lastC)) {
                    botState = { ...botState, positionType: 'LONG', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC - (curA * 3) };
                    saveState();
                }
            } else if (curE50 < curE200 && lastV > (curV * 1.5) && lastC < bL) {
                if (await placeOrder("SELL", MAX_QUANTITY, lastC)) {
                    botState = { ...botState, positionType: 'SHORT', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC + (curA * 3) };
                    saveState();
                }
            }
        } else {
            // Trailing Stop logic
            if (botState.positionType === 'LONG') {
                botState.currentStop = Math.max(lastC - (curA * 3), botState.currentStop);
                if (lastC < botState.currentStop && await placeOrder("SELL", botState.quantity, lastC)) {
                    botState.totalPnL += (lastC - botState.entryPrice) * botState.quantity;
                    botState.positionType = null; saveState();
                }
            } else {
                botState.currentStop = Math.min(lastC + (curA * 3), botState.currentStop);
                if (lastC > botState.currentStop && await placeOrder("BUY", botState.quantity, lastC)) {
                    botState.totalPnL += (botState.entryPrice - lastC) * botState.quantity;
                    botState.positionType = null; saveState();
                }
            }
        }
    } catch (e) { console.log("Data Fetch Error"); }
}, 30000);

// Dashboard routes
app.get('/', (req, res) => { res.send(`<h1>Silver Bot Live</h1><p>PnL: ${botState.totalPnL}</p>`); });
app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });

// 🔥 RENDER PORT FIX
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
