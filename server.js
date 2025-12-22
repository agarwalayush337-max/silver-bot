const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const STATE_FILE = './bot_state.json';
const MAX_QUANTITY = 1; 

// --- STATE PERSISTENCE ---
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0 };
if (fs.existsSync(STATE_FILE)) {
    try {
        botState = JSON.parse(fs.readFileSync(STATE_FILE));
        console.log("📂 State recovered from memory.");
    } catch (e) { console.log("State file corrupted, resetting."); }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }

// --- MARKET TIMER (8:45 AM - 11:59 PM IST) ---
function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false; 
    return totalMin >= 525 && totalMin < 1439; 
}

// --- ORDER EXECUTION (Corrected for V3 Trigger Price) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN) return false;
    
    const isAmo = !isMarketOpen();
    const buffer = ltp * 0.01;
    // For MARKET simulation via LIMIT, we add a 1% buffer
    const limitPrice = type === "BUY" ? (ltp + buffer) : (ltp - buffer);

    const orderData = {
        quantity: qty,
        product: "I",
        validity: "DAY",
        price: Math.round(limitPrice * 20) / 20, // Rounded to nearest 0.05
        instrument_token: INSTRUMENT_KEY,
        order_type: "LIMIT",
        transaction_type: type,
        disclosed_quantity: 0,
        trigger_price: 0, // 👈 FIXED: Mandatory field for V3
        is_amo: isAmo   // 👈 Enables testing while market is closed
    };

    try {
        const res = await axios.post("https://api.upstox.com/v3/order/place", orderData, {
            headers: { 
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log(`✅ ${isAmo ? 'AMO ' : ''}${type} Success! ID: ${res.data.data.order_id}`);
        return true;
    } catch (e) {
        const errorMsg = e.response?.data?.errors[0]?.message || e.message;
        console.error(`❌ Order Failed: ${errorMsg}`);
        return false;
    }
}

// --- TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;
    if (!isMarketOpen()) {
        console.log(`😴 [${new Date().toLocaleTimeString()}] Market Closed. Bot Idle.`);
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
            const volSpike = lastV > (curV * 1.5);
            if (curE50 > curE200 && volSpike && lastC > bH) {
                if (await placeOrder("BUY", MAX_QUANTITY, lastC)) {
                    botState = { ...botState, positionType: 'LONG', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC - (curA * 3) };
                    saveState();
                }
            } else if (curE50 < curE200 && volSpike && lastC < bL) {
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
    } catch (e) { console.log("Data Fetch Standby..."); }
}, 30000);

// --- DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:50px; background:#0f172a; color:white; min-height:100vh;">
            <div style="max-width:500px; margin:auto; background:#1e293b; padding:30px; border-radius:12px;">
                <h1 style="color:#38bdf8;">🥈 Silver Prime v2025</h1>
                <hr style="border:0.5px solid #334155; margin:20px 0;">
                <p>Status: <b style="color:${ACCESS_TOKEN ? '#4ade80' : '#f87171'}">${ACCESS_TOKEN ? 'ACTIVE' : 'TOKEN REQ'}</b></p>
                <p>Position: <b>${botState.positionType || 'NONE'}</b></p>
                <p>PnL: <b>₹${botState.totalPnL.toFixed(2)}</b></p>
                <form action="/update-token" method="POST" style="margin-top:20px;">
                    <input name="token" type="text" placeholder="Access Token" style="padding:10px; width:80%; border-radius:5px; border:none; margin-bottom:10px;">
                    <button type="submit" style="padding:10px 20px; background:#38bdf8; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">ACTIVATE</button>
                </form>
                <div style="margin-top:20px;"><a href="/test-amo" style="color:#94a3b8; text-decoration:none;">🛠️ Manual AMO Ping Test</a></div>
            </div>
        </div>
    `);
});

app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });

app.get('/test-amo', async (req, res) => {
    const success = await placeOrder("BUY", 1, 75000);
    res.send(success ? "<h1>✅ Success!</h1><a href='/'>Back</a>" : "<h1>❌ Failed. Enter Token first.</h1><a href='/'>Back</a>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server live on port ${PORT}`));
