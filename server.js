const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- USER CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; // Ensure this key is valid!
const MAX_QUANTITY = 1;
// --------------------------

let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
const REDIS_URL = process.env.REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379";

// --- REDIS SETUP ---
const redis = new Redis(REDIS_URL);
let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 Redis: State recovered successfully.");
    } catch (e) { console.log("Redis sync issue (fresh start)."); }
}
loadState();

async function saveState() {
    await redis.set('silver_bot_state', JSON.stringify(botState));
}

// --- TIME & HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }

function isApiAvailable() {
    const totalMin = (getIST().getHours() * 60) + getIST().getMinutes();
    return totalMin >= 330 && totalMin < 1440; // 5:30 AM - 12:00 AM
}
function isMarketOpen() {
    const ist = getIST();
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    return day !== 0 && day !== 6 && totalMin >= 525 && totalMin < 1439; // 8:45 AM - 11:59 PM
}

// --- SMART DATA FETCHING ---
async function getMergedCandles() {
    const today = new Date();
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(today.getDate() - 10);

    const todayStr = formatDate(today);
    const prevStr = formatDate(tenDaysAgo);
    
    const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
    const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${todayStr}/${prevStr}`;

    try {
        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } }))
        ]);

        const histCandles = histRes.data?.data?.candles || [];
        const intraCandles = intraRes.data?.data?.candles || [];

        const candleMap = new Map();
        histCandles.forEach(c => candleMap.set(c[0], c));
        intraCandles.forEach(c => candleMap.set(c[0], c));
        
        return Array.from(candleMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));

    } catch (e) {
        console.log("Merge Error: " + e.message);
        return [];
    }
}

// --- ORDER EXECUTION (FIXED TICK SIZE & ERROR LOGGING) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const isAmo = !isMarketOpen();
    const buffer = ltp * 0.01;
    const rawPrice = type === "BUY" ? (ltp + buffer) : (ltp - buffer);

    // ✅ FIX 1: Round to nearest Integer (Tick Size 1.0)
    const limitPrice = Math.round(rawPrice); 

    try {
        console.log(`Attempting ${type} at ₹${limitPrice}...`);

        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY",
            price: limitPrice, // Sending whole number
            instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0,
            trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = res.data.data.order_id;
        console.log(`✅ SUCCESS: ${type} Order ID: ${orderId}`);

        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type: type, 
            price: limitPrice, 
            id: orderId, // Store Order ID
            status: "SUCCESS"
        });
        await saveState();
        return true;

    } catch (e) { 
        // ✅ FIX 2: Capture Error and Save to History
        const errorMsg = e.response?.data?.errors[0]?.message || e.message;
        console.error(`❌ FAILED: ${errorMsg}`);
        
        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type: "REJECT", 
            price: limitPrice, 
            id: errorMsg, // Store Error Message in ID column
            status: "FAILED"
        });
        await saveState();
        return false; 
    }
}

// --- MAIN ENGINE LOOP ---
setInterval(async () => {
    if (!ACCESS_TOKEN) { console.log(`📡 Bot IDLE: Waiting for Token...`); return; }
    if (!isApiAvailable()) { console.log(`😴 API Maintenance. Sleeping...`); return; }

    try {
        const candles = await getMergedCandles();
        
        if (candles && candles.length > 200) {
            const cl = candles.map(c => c[4]);
            lastKnownLtp = cl[cl.length-1];
            
            console.log(`🔎 [${getIST().toLocaleTimeString()}] Analysis Active | LTP: ${lastKnownLtp}`);

            if (isMarketOpen()) {
                const h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);
                
                const e50 = EMA.calculate({period: 50, values: cl});
                const e200 = EMA.calculate({period: 200, values: cl});
                const vAvg = SMA.calculate({period: 20, values: v});
                const atr = ATR.calculate({high: h, low: l, close: cl, period: 14});

                const lastC = lastKnownLtp;
                const lastV = v[v.length-1];
                const curE50 = e50[e50.length-1];
                const curE200 = e200[e200.length-1];
                const curV = vAvg[vAvg.length-1];
                const curA = atr[atr.length-1];
                
                const bH = Math.max(...h.slice(-11, -1));
                const bL = Math.min(...l.slice(-11, -1));

                if (!botState.positionType) {
                    // BUY
                    if (curE50 > curE200 && lastV > (curV * 1.5) && lastC > bH) {
                        if (await placeOrder("BUY", MAX_QUANTITY, lastC)) {
                            botState = { ...botState, positionType: 'LONG', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC - (curA * 3) };
                            await saveState();
                        }
                    } 
                    // SELL
                    else if (curE50 < curE200 && lastV > (curV * 1.5) && lastC < bL) {
                        if (await placeOrder("SELL", MAX_QUANTITY, lastC)) {
                            botState = { ...botState, positionType: 'SHORT', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC + (curA * 3) };
                            await saveState();
                        }
                    }
                } else {
                    // EXIT
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
        } else {
            console.log(`⚠️ Gathering Data... (${candles.length}/200 candles)`);
        }
    } catch (e) {
        if (e.response?.status === 401) {
            console.log("❌ Token Expired. Update via Dashboard.");
            ACCESS_TOKEN = null;
        } else {
            console.log(`⏳ API Check: ${e.message}`);
        }
    }
}, 30000);

// --- DASHBOARD UI (Now Shows Rejected Orders) ---
app.get('/', (req, res) => {
    const isActivated = ACCESS_TOKEN !== null;
    const statusColor = isActivated ? "#4ade80" : "#f87171";

    let historyHTML = botState.history.slice(0, 8).map(t => {
        let color = t.type === 'BUY' ? '#4ade80' : (t.type === 'SELL' ? '#f87171' : '#f43f5e'); // Red for Reject
        let icon = t.status === 'FAILED' ? '❌' : (t.type === 'BUY' ? '🟢' : '🔴');
        
        return `
        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; font-size:12px;">
            <div style="width: 20%;">${t.time}</div>
            <div style="width: 20%; font-weight:bold; color:${color};">${icon} ${t.type}</div>
            <div style="width: 20%;">₹${t.price}</div>
            <div style="width: 40%; text-align:right; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${t.id}">${t.id}</div>
        </div>`;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html style="background:#0f172a;">
        <head>
            <title>Silver Prime v2025</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="30">
        </head>
        <body style="font-family:sans-serif; color:white; display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:480px; background:#1e293b; border-radius:20px; padding:20px; border:1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <h2 style="color:#38bdf8; text-align:center; margin-bottom:5px;">🥈 Silver Prime Bot</h2>
                <p style="text-align:center; color:#64748b; font-size:11px;">LAST SYNC: ${getIST().toLocaleTimeString()}</p>
                
                <div style="background:#0f172a; padding:15px; border-radius:12px; margin:20px 0; text-align:center; border: 1px solid #334155;">
                    <small style="color:#64748b;">LIVE PRICE (5-MIN)</small><br>
                    <span style="font-size:28px; font-weight:bold; color:#fbbf24;">₹${lastKnownLtp || 'WAITING...'}</span>
                </div>

                <div style="text-align:center; margin-bottom:20px;">
                    <b style="color:${statusColor}; font-size:13px;">● ${isActivated ? 'ACTIVE' : 'TOKEN REQUIRED'}</b>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px;">
                    <div style="background:#0f172a; padding:12px; border-radius:10px; text-align:center;">
                        <small style="color:#64748b;">PNL</small><br><b style="font-size:16px;">₹${botState.totalPnL.toFixed(2)}</b>
                    </div>
                    <div style="background:#0f172a; padding:12px; border-radius:10px; text-align:center;">
                        <small style="color:#64748b;">POS</small><br><b style="font-size:16px; color:#fbbf24;">${botState.positionType || 'FLAT'}</b>
                    </div>
                </div>

                <form action="/update-token" method="POST">
                    <input name="token" type="text" placeholder="Paste Token Here" style="width:100%; padding:12px; border-radius:8px; background:#0f172a; color:white; border:1px solid #334155; margin-bottom:10px; box-sizing:border-box;">
                    <button type="submit" style="width:100%; padding:12px; background:#38bdf8; border:none; border-radius:8px; font-weight:bold; color:#0f172a; cursor:pointer;">ACTIVATE ENGINE</button>
                </form>

                <h4 style="color:#94a3b8; margin-top:25px; border-bottom:1px solid #334155; padding-bottom:5px;">Live Order Log</h4>
                <div style="margin-top:10px;">
                    ${historyHTML || '<p style="text-align:center;color:#475569;font-size:13px;">No orders yet.</p>'}
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/update-token', (req, res) => { ACCESS_TOKEN = req.body.token; res.redirect('/'); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot Live on ${PORT}`));
