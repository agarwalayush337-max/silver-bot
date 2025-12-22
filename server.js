const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305";
const REDIS_URL = process.env.REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379";
const MAX_QUANTITY = 1;

// --- REDIS SETUP ---
const redis = new Redis(REDIS_URL);
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

// Load State from Redis on startup
async function loadState() {
    const saved = await redis.get('silver_bot_state');
    if (saved) {
        botState = JSON.parse(saved);
        console.log("📂 Redis: State recovered successfully.");
    }
}
loadState();

async function saveState() {
    await redis.set('silver_bot_state', JSON.stringify(botState));
}

// --- HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function isApiAvailable() {
    const totalMin = (getIST().getHours() * 60) + getIST().getMinutes();
    return totalMin >= 330 && totalMin < 1440;
}
function isMarketOpen() {
    const ist = getIST();
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    return ist.getDay() !== 0 && ist.getDay() !== 6 && totalMin >= 525 && totalMin < 1439;
}

// --- ORDER EXECUTION ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const isAmo = !isMarketOpen();
    const buffer = ltp * 0.01;
    const limitPrice = type === "BUY" ? (ltp + buffer) : (ltp - buffer);

    try {
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY",
            price: Math.round(limitPrice * 20) / 20, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0,
            trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        botState.history.unshift({ time: getIST().toLocaleTimeString(), type, price: ltp, qty, id: res.data.data.order_id });
        await saveState();
        return true;
    } catch (e) { return false; }
}

// --- ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable() || !isMarketOpen()) return;
    try {
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const candles = res.data.data.candles.reverse();
        const h = candles.map(c => c[2]), l = candles.map(c => c[3]), cl = candles.map(c => c[4]), v = candles.map(c => c[5]);

        const e50 = EMA.calculate({period: 50, values: cl}), e200 = EMA.calculate({period: 200, values: cl});
        const vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: cl, period: 14});

        const lastC = cl[cl.length-1], lastV = v[v.length-1], curE50 = e50[e50.length-1], curE200 = e200[e200.length-1], curV = vAvg[vAvg.length-1], curA = atr[atr.length-1];
        const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

        if (!botState.positionType) {
            if (curE50 > curE200 && lastV > (curV * 1.5) && lastC > bH) {
                if (await placeOrder("BUY", MAX_QUANTITY, lastC)) {
                    botState = { ...botState, positionType: 'LONG', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC - (curA * 3) };
                    await saveState();
                }
            } else if (curE50 < curE200 && lastV > (curV * 1.5) && lastC < bL) {
                if (await placeOrder("SELL", MAX_QUANTITY, lastC)) {
                    botState = { ...botState, positionType: 'SHORT', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC + (curA * 3) };
                    await saveState();
                }
            }
        } else {
            if (botState.positionType === 'LONG') {
                botState.currentStop = Math.max(lastC - (curA * 3), botState.currentStop);
                if (lastC < botState.currentStop && await placeOrder("SELL", botState.quantity, lastC)) {
                    botState.totalPnL += (lastC - botState.entryPrice) * botState.quantity;
                    botState.positionType = null; await saveState();
                }
            } else {
                botState.currentStop = Math.min(lastC + (curA * 3), botState.currentStop || 999999);
                if (lastC > botState.currentStop && await placeOrder("BUY", botState.quantity, lastC)) {
                    botState.totalPnL += (botState.entryPrice - lastC) * botState.quantity;
                    botState.positionType = null; await saveState();
                }
            }
        }
    } catch (e) { console.log("Engine Standby"); }
}, 30000);

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    let rows = botState.history.slice(0, 10).map(t => `<tr><td>${t.time}</td><td style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</td><td>₹${t.price}</td></tr>`).join('');
    res.send(`
        <body style="font-family:sans-serif; background:#0f172a; color:white; text-align:center; padding:40px;">
            <div style="max-width:500px; margin:auto; background:#1e293b; padding:30px; border-radius:12px;">
                <h1 style="color:#38bdf8;">Silver Prime Redis</h1>
                <p>PnL: ₹${botState.totalPnL.toFixed(2)} | Position: ${botState.positionType || 'FLAT'}</p>
                <div style="background:#0f172a; border-radius:8px; margin:20px 0; overflow:hidden;">
                    <table style="width:100%; text-align:left; border-collapse:collapse;">
                        <tr style="background:#334155;"><th style="padding:10px;">Time</th><th style="padding:10px;">Type</th><th style="padding:10px;">Price</th></tr>
                        ${rows || '<tr><td colspan="3" style="padding:10px;text-align:center;">No History</td></tr>'}
                    </table>
                </div>
                <form action="/update-token" method="POST">
                    <input name="token" type="text" placeholder="Access Token" style="padding:10px; width:80%; border-radius:5px; margin-bottom:10px;">
                    <button type="submit" style="padding:10px 20px; background:#38bdf8; border:none; border-radius:5px; font-weight:bold; cursor:pointer;">ACTIVATE</button>
                </form>
            </div>
        </body>
    `);
});

app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Redis Bot live on ${PORT}`));
