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

// --- STATE MANAGEMENT ---
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0 };
if (fs.existsSync(STATE_FILE)) {
    try {
        botState = JSON.parse(fs.readFileSync(STATE_FILE));
        console.log("📂 State recovered from bot_state.json");
    } catch (e) { console.log("State file reset due to error"); }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }

// --- MARKET HOURS (8:45 AM - 11:59 PM IST) ---
function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    return totalMin >= 525 && totalMin < 1439; 
}

// --- ORDER EXECUTION ---
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
        console.log(`✅ Order Success: ${type} ${qty} Lot(s)`);
        return true;
    } catch (e) {
        console.error(`❌ Order Failed: ${e.response?.data?.errors[0]?.message || e.message}`);
        return false;
    }
}

// --- TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;
    if (!isMarketOpen()) {
        console.log("😴 Market Closed. Bot is in standby mode.");
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
    } catch (e) { console.log("⏳ Fetching live data..."); }
}, 30000);

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    res.send(`
        <html>
        <body style="font-family: sans-serif; background: #0f172a; color: white; text-align: center; padding-top: 50px;">
            <div style="max-width: 500px; margin: auto; background: #1e293b; padding: 30px; border-radius: 12px; border: 1px solid #334155;">
                <h1 style="color: #38bdf8;">🥈 Silver Prime v2025</h1>
                <hr style="border: 0.5px solid #334155;">
                <div style="margin: 20px 0;">
                    <p>Status: <b style="color: ${ACCESS_TOKEN ? '#4ade80' : '#f87171'}">${ACCESS_TOKEN ? 'ACTIVE' : 'TOKEN REQUIRED'}</b></p>
                    <p>Current PnL: <span style="font-size: 1.5em; font-weight: bold;">₹${botState.totalPnL.toFixed(2)}</span></p>
                    <p>Position: <b>${botState.positionType || 'NONE'}</b></p>
                </div>
                
                <form action="/update-token" method="POST" style="margin-top: 30px;">
                    <input name="token" type="text" placeholder="Paste Upstox Access Token" required 
                           style="width: 100%; padding: 12px; border-radius: 6px; border: none; margin-bottom: 10px; background: #0f172a; color: white; border: 1px solid #334155;">
                    <button type="submit" style="width: 100%; padding: 12px; border-radius: 6px; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; cursor: pointer;">
                        ACTIVATE BOT
                    </button>
                </form>
                <div style="margin-top: 20px;">
                    <a href="/test-amo" style="color: #94a3b8; text-decoration: none; font-size: 0.8em;">🛠️ Trigger Manual AMO Test</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

app.get('/test-amo', async (req, res) => {
    const success = await placeOrder("BUY", 1, 75000);
    res.send(success ? "<h1>✅ Test Order Sent!</h1><a href='/'>Back</a>" : "<h1>❌ Error. Paste token first.</h1><a href='/'>Back</a>");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Web Interface live on port ${PORT}`));
