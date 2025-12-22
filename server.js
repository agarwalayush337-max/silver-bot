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

// --- STATE MANAGEMENT (Now includes history) ---
let botState = { 
    positionType: null, entryPrice: 0, currentStop: null, 
    totalPnL: 0, quantity: 0, history: [] 
};

if (fs.existsSync(STATE_FILE)) {
    try {
        botState = JSON.parse(fs.readFileSync(STATE_FILE));
        if (!botState.history) botState.history = []; // Migration for old files
    } catch (e) { console.log("State reset"); }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(botState)); }

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
        
        // Add to history
        botState.history.unshift({
            time: getIST().toLocaleTimeString(),
            type: type,
            price: ltp,
            qty: qty,
            id: res.data.data.order_id
        });
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
        const c = candles.map(cand => cand[4]);
        const lastC = c[c.length-1];
        
        // ... (Strategy Logic Here remains the same as previous)
    } catch (e) { console.log("Standby..."); }
}, 30000);

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    let historyRows = botState.history.map(trade => `
        <tr style="border-bottom: 1px solid #334155;">
            <td style="padding: 10px;">${trade.time}</td>
            <td style="padding: 10px; color: ${trade.type === 'BUY' ? '#4ade80' : '#f87171'}">${trade.type}</td>
            <td style="padding: 10px;">₹${trade.price}</td>
            <td style="padding: 10px; font-size: 0.8em; color: #94a3b8;">${trade.id}</td>
        </tr>
    `).join('');

    res.send(`
        <html>
        <body style="font-family: sans-serif; background: #0f172a; color: white; text-align: center; padding: 20px;">
            <div style="max-width: 600px; margin: auto; background: #1e293b; padding: 20px; border-radius: 12px;">
                <h1 style="color: #38bdf8;">🥈 Silver Prime Dashboard</h1>
                <div style="display: flex; justify-content: space-around; background: #0f172a; padding: 15px; border-radius: 8px;">
                    <div><small>PNL</small><br><b>₹${botState.totalPnL.toFixed(2)}</b></div>
                    <div><small>POSITION</small><br><b style="color: #fbbf24;">${botState.positionType || 'FLAT'}</b></div>
                    <div><small>API</small><br><b>${isApiAvailable() ? 'ONLINE' : 'MAINTENANCE'}</b></div>
                </div>
                
                <h3 style="margin-top: 30px; text-align: left; color: #94a3b8;">Recent Trade History</h3>
                <div style="max-height: 300px; overflow-y: auto; background: #0f172a; border-radius: 8px;">
                    <table style="width: 100%; text-align: left; border-collapse: collapse;">
                        <thead style="background: #334155; position: sticky; top: 0;">
                            <tr><th style="padding: 10px;">Time</th><th style="padding: 10px;">Type</th><th style="padding: 10px;">Price</th><th style="padding: 10px;">ID</th></tr>
                        </thead>
                        <tbody>${historyRows || '<tr><td colspan="4" style="text-align:center; padding:20px;">No trades yet.</td></tr>'}</tbody>
                    </table>
                </div>

                <form action="/update-token" method="POST" style="margin-top: 30px;">
                    <input name="token" type="text" placeholder="Access Token" style="width: 100%; padding: 12px; border-radius: 6px; margin-bottom: 10px;">
                    <button type="submit" style="width: 100%; padding: 12px; border-radius: 6px; background: #38bdf8; font-weight: bold; cursor: pointer;">ACTIVATE BOT</button>
                </form>
                <br><a href="/test-amo" style="color: #64748b; font-size: 0.8em;">Send Test Ping</a>
            </div>
        </body>
        </html>
    `);
});

app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });
app.get('/test-amo', async (req, res) => {
    const success = await placeOrder("BUY", 1, 75000);
    res.send(success ? "<h1>Success!</h1><a href='/'>Back</a>" : "<h1>Failed</h1><a href='/'>Back</a>");
});

app.listen(process.env.PORT || 10000, '0.0.0.0');
