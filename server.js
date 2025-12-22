const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIG ---
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
const INSTRUMENT_KEY = "MCX_FO|458305";
const REDIS_URL = process.env.REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379";
const MAX_QUANTITY = 1;

// --- REDIS SETUP ---
const redis = new Redis(REDIS_URL);
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 Redis memory loaded.");
    } catch (e) { console.log("Redis sync issue."); }
}
loadState();

async function saveState() {
    await redis.set('silver_bot_state', JSON.stringify(botState));
}

// --- TIME HELPERS ---
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

// --- ORDER LOGIC ---
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

// --- TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) return;
    
    try {
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const candles = res.data.data.candles.reverse();
        const cl = candles.map(c => c[4]);
        
        lastKnownLtp = cl[cl.length-1]; 

        if (isMarketOpen()) {
            const h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);
            const e50 = EMA.calculate({period: 50, values: cl}), e200 = EMA.calculate({period: 200, values: cl});
            const vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: cl, period: 14});

            const lastC = lastKnownLtp, lastV = v[v.length-1], curE50 = e50[e50.length-1], curE200 = e200[e200.length-1], curV = vAvg[vAvg.length-1], curA = atr[atr.length-1];
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
        }
    } catch (e) { console.log("Engine sync..."); }
}, 30000);

// --- UPDATED UI WITH AUTO-REFRESH ---
app.get('/', (req, res) => {
    const isActivated = ACCESS_TOKEN !== null;
    const statusColor = isActivated ? "#4ade80" : "#f87171";

    let historyHTML = botState.history.slice(0, 5).map(t => `
        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; font-size:13px;">
            <span>${t.time}</span> <b style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</b> <span>₹${t.price}</span>
        </div>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html style="background:#0f172a;">
        <head>
            <title>Silver Prime v2025</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="30"> </head>
        <body style="font-family:sans-serif; color:white; display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:450px; background:#1e293b; border-radius:20px; padding:30px; border:1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <h2 style="color:#38bdf8; text-align:center; margin-bottom:5px;">🥈 Silver Prime Bot</h2>
                <p style="text-align:center; color:#64748b; font-size:11px; margin-bottom:20px;">LAST SYNC: ${getIST().toLocaleTimeString()}</p>
                
                <div style="background:#0f172a; padding:15px; border-radius:12px; margin-bottom:20px; text-align:center; border: 1px solid #334155;">
                    <small style="color:#64748b; letter-spacing:1px;">SILVER MICRO LTP</small><br>
                    <span style="font-size:28px; font-weight:bold; color:#fbbf24;">₹${lastKnownLtp || 'WAITING...'}</span>
                </div>

                <div style="margin:15px 0; text-align:center;">
                    <b style="color:${statusColor}; font-size:13px; letter-spacing:1px;">● ${isActivated ? 'ACTIVE' : 'TOKEN REQUIRED'}</b>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:25px;">
                    <div style="background:#0f172a; padding:12px; border-radius:10px; text-align:center;">
                        <small style="color:#64748b;">TOTAL PNL</small><br><b style="font-size:16px;">₹${botState.totalPnL.toFixed(2)}</b>
                    </div>
                    <div style="background:#0f172a; padding:12px; border-radius:10px; text-align:center;">
                        <small style="color:#64748b;">POSITION</small><br><b style="font-size:16px; color:#fbbf24;">${botState.positionType || 'FLAT'}</b>
                    </div>
                </div>

                <form action="/update-token" method="POST">
                    <input name="token" type="text" placeholder="Enter Access Token" style="width:100%; padding:12px; border-radius:8px; background:#0f172a; color:white; border:1px solid #334155; margin-bottom:10px; box-sizing:border-box;">
                    <button type="submit" style="width:100%; padding:12px; background:#38bdf8; border:none; border-radius:8px; font-weight:bold; color:#0f172a; cursor:pointer;">ACTIVATE ENGINE</button>
                </form>

                <h4 style="color:#94a3b8; margin-top:30px; border-bottom:1px solid #334155; padding-bottom:5px;">Session History</h4>
                <div style="margin-top:15px;">
                    ${historyHTML || '<p style="text-align:center;color:#475569;font-size:13px;">No trade signals detected yet.</p>'}
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot Console live`));
