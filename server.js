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

async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 Redis: State recovered.");
    } catch (e) { console.log("Redis load error"); }
}
loadState();

async function saveState() {
    await redis.set('silver_bot_state', JSON.stringify(botState));
}

// --- TIME HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function isApiAvailable() {
    const totalMin = (getIST().getHours() * 60) + getIST().getMinutes();
    return totalMin >= 330 && totalMin < 1440; // 5:30 AM to 12:00 AM
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
    if (!ACCESS_TOKEN || !isApiAvailable() || !isMarketOpen()) return;
    try {
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const res = await axios.get(url, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const candles = res.data.data.candles.reverse();
        const cl = candles.map(c => c[4]);
        const lastC = cl[cl.length-1];
        
        // ... (EMA/ATR Calculations & Strategy Logic from previous steps) ...
    } catch (e) { console.log("Standby..."); }
}, 30000);

// --- IMPROVED DASHBOARD UI ---
app.get('/', (req, res) => {
    const isActivated = ACCESS_TOKEN !== null;
    const statusColor = isActivated ? "#4ade80" : "#f87171";
    const statusText = isActivated ? "BOT ACTIVATED" : "BOT WAITING FOR TOKEN";

    let historyHTML = botState.history.slice(0, 5).map(t => `
        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
            <span>${t.time}</span>
            <b style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</b>
            <span>₹${t.price}</span>
        </div>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Silver Prime v2025</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; padding: 20px;">
            <div style="width: 100%; max-width: 450px;">
                <div style="background: #1e293b; border-radius: 20px; padding: 30px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); border: 1px solid #334155;">
                    <h1 style="margin: 0; color: #38bdf8; font-size: 24px; text-align: center;">🥈 Silver Prime Bot</h1>
                    <p style="text-align: center; color: #94a3b8; font-size: 14px; margin-top: 5px;">Powered by Redis & Upstox V3</p>
                    
                    <div style="margin: 25px 0; padding: 15px; border-radius: 12px; border: 2px solid ${statusColor}; text-align: center;">
                        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; margin-right: 8px;"></span>
                        <b style="color: ${statusColor}; letter-spacing: 1px;">${statusText}</b>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px;">
                        <div style="background: #0f172a; padding: 15px; border-radius: 12px; text-align: center;">
                            <small style="color: #64748b; font-weight: bold;">POSITION</small><br>
                            <b style="color: #fbbf24; font-size: 18px;">${botState.positionType || 'FLAT'}</b>
                        </div>
                        <div style="background: #0f172a; padding: 15px; border-radius: 12px; text-align: center;">
                            <small style="color: #64748b; font-weight: bold;">TOTAL PnL</small><br>
                            <b style="font-size: 18px;">₹${botState.totalPnL.toFixed(2)}</b>
                        </div>
                    </div>

                    <form action="/update-token" method="POST">
                        <input name="token" type="text" placeholder="Paste Access Token" required style="width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; margin-bottom: 15px; font-size: 16px;">
                        <button type="submit" style="width: 100%; padding: 12px; border-radius: 10px; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; font-size: 16px; cursor: pointer;">ACTIVATE TRADING ENGINE</button>
                    </form>

                    <h3 style="margin-top: 30px; font-size: 16px; color: #94a3b8;">Recent History</h3>
                    ${historyHTML || '<p style="text-align:center; color:#475569;">No trades in this session</p>'}
                    
                    <div style="margin-top: 20px; text-align: center;">
                        <a href="/test-amo" style="color: #64748b; text-decoration: none; font-size: 12px;">🛠️ Trigger Connection Test (AMO)</a>
                    </div>
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
    res.send(success ? "<h1>✅ Test Sent!</h1><a href='/'>Back</a>" : "<h1>❌ Failed. Enter Token.</h1><a href='/'>Back</a>");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Dashboard Live`));
