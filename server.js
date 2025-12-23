const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { EMA, SMA, ATR } = require("technicalindicators");

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; // Silver Mic Feb 28
const MAX_QUANTITY = 1;
// ---------------------

let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
const REDIS_URL = process.env.REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379";
const redis = new Redis(REDIS_URL);

let botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, history: [] };

// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 Redis: State loaded.");
    } catch (e) { console.log("Redis sync issue."); }
}
loadState();

async function saveState() {
    await redis.set('silver_bot_state', JSON.stringify(botState));
}

// --- HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }

function isApiAvailable() {
    const totalMin = (getIST().getHours() * 60) + getIST().getMinutes();
    return totalMin >= 330 && totalMin < 1440; 
}
function isMarketOpen() {
    const ist = getIST();
    const totalMin = (ist.getHours() * 60) + ist.getMinutes();
    const day = ist.getDay();
    return day !== 0 && day !== 6 && totalMin >= 525 && totalMin < 1439;
}

// --- ORDER EXECUTION ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const isAmo = !isMarketOpen();
    const buffer = ltp * 0.01;
    
    // ✅ ROUND TO INTEGER (Fixes Tick Size Error)
    const limitPrice = Math.round(type === "BUY" ? (ltp + buffer) : (ltp - buffer));

    try {
        console.log(`🚀 Sending ${type} Order: ${qty} Lot @ ₹${limitPrice}`);

        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY",
            price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0,
            trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = res.data.data.order_id;
        console.log(`✅ ORDER ACCEPTED: ${orderId}`);

        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: type, price: limitPrice, id: orderId, status: "SENT" });
        await saveState();
        return true;

    } catch (e) { 
        const err = e.response?.data?.errors[0]?.message || e.message;
        console.error(`❌ ORDER REJECTED: ${err}`);
        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "ERROR", price: limitPrice, id: err, status: "FAILED" });
        await saveState();
        return false; 
    }
}

// --- MAIN ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) { console.log("📡 IDLE: Waiting for valid token..."); return; }
    if (!isApiAvailable()) { console.log("😴 API Sleeping (12AM-5:30AM)"); return; }

    try {
        // --- 1. DATA FETCHING ---
        const today = new Date();
        const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
        
        // Correct V3 URLs
        const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
        const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } }))
        ]);

        const mergedMap = new Map();
        (histRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        (intraRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        const candles = Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));

        if (candles.length > 200) {
            const cl = candles.map(c => c[4]);
            lastKnownLtp = cl[cl.length-1];

            // --- 2. VERBOSE LOGGING (Shows Basis of Order) ---
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

                // 📊 STRATEGY SPY: Prints logic to logs
                console.log(`📊 [${getIST().toLocaleTimeString()}] Price: ${lastC} | E50: ${curE50.toFixed(1)} | E200: ${curE200.toFixed(1)} | Vol: ${lastV} (Avg: ${curV.toFixed(0)})`);

                // --- 3. TRADING LOGIC ---
                if (!botState.positionType) {
                    // BUY?
                    if (curE50 > curE200 && lastV > (curV * 1.5) && lastC > bH) {
                        console.log("⚡ BUY SIGNAL DETECTED!");
                        if (await placeOrder("BUY", MAX_QUANTITY, lastC)) {
                            botState = { ...botState, positionType: 'LONG', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC - (curA * 3) };
                            await saveState();
                        }
                    } 
                    // SELL?
                    else if (curE50 < curE200 && lastV > (curV * 1.5) && lastC < bL) {
                        console.log("⚡ SELL SIGNAL DETECTED!");
                        if (await placeOrder("SELL", MAX_QUANTITY, lastC)) {
                            botState = { ...botState, positionType: 'SHORT', entryPrice: lastC, quantity: MAX_QUANTITY, currentStop: lastC + (curA * 3) };
                            await saveState();
                        }
                    }
                } else {
                    // EXIT/TRAIL
                    if (botState.positionType === 'LONG') {
                        botState.currentStop = Math.max(lastC - (curA * 3), botState.currentStop);
                        if (lastC < botState.currentStop) {
                            console.log("🛑 HIT TRAILING STOP (LONG)");
                            if (await placeOrder("SELL", botState.quantity, lastC)) {
                                botState.totalPnL += (lastC - botState.entryPrice) * botState.quantity;
                                botState.positionType = null; await saveState();
                            }
                        }
                    } else {
                        botState.currentStop = Math.min(lastC + (curA * 3), botState.currentStop || 999999);
                        if (lastC > botState.currentStop) {
                            console.log("🛑 HIT TRAILING STOP (SHORT)");
                            if (await placeOrder("BUY", botState.quantity, lastC)) {
                                botState.totalPnL += (botState.entryPrice - lastC) * botState.quantity;
                                botState.positionType = null; await saveState();
                            }
                        }
                    }
                }
            } else {
                console.log(`💤 Market Closed. Watching Price: ${lastKnownLtp}`);
            }
        }
    } catch (e) {
        if (e.response?.status === 401) {
            console.log("❌ TOKEN EXPIRED. DISABLE BOT.");
            ACCESS_TOKEN = null; // Auto-Kill
        } else {
            console.log(`⏳ Loop Error: ${e.message}`);
        }
    }
}, 30000);

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    const isActivated = ACCESS_TOKEN !== null;
    const statusColor = isActivated ? "#4ade80" : "#ef4444";
    
    // History Table HTML
    let historyRows = botState.history.slice(0, 10).map(t => {
        const color = t.type === 'BUY' ? '#4ade80' : (t.type === 'SELL' ? '#f87171' : '#fbbf24');
        return `<div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #334155; font-size:12px;">
            <span>${t.time}</span> <b style="color:${color}">${t.type}</b> <span>₹${t.price}</span>
        </div>`;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30"></head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
                <h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime Control</h2>
                <div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:20px;">
                    <small style="color:#94a3b8;">LIVE PRICE</small><br>
                    <b style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp || '---'}</b>
                </div>

                <div style="display:flex; gap:10px; margin-bottom:20px;">
                    <div style="flex:1; background:#0f172a; padding:10px; border-radius:8px; text-align:center;">
                        <small style="color:#94a3b8;">STATUS</small><br>
                        <b style="color:${statusColor}">${isActivated ? 'ONLINE' : 'OFFLINE'}</b>
                    </div>
                    <div style="flex:1; background:#0f172a; padding:10px; border-radius:8px; text-align:center;">
                        <small style="color:#94a3b8;">POSITION</small><br>
                        <b style="color:#facc15;">${botState.positionType || 'NONE'}</b>
                    </div>
                </div>

                <form action="/update-token" method="POST" style="margin-bottom:15px;">
                    <input name="token" type="text" placeholder="Paste Daily Access Token" style="width:100%; padding:12px; border-radius:8px; border:none; margin-bottom:10px; box-sizing:border-box;">
                    <button type="submit" style="width:100%; padding:12px; background:#38bdf8; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">✅ ACTIVATE BOT</button>
                </form>

                <form action="/reset-state" method="POST">
                     <button type="submit" style="width:100%; padding:10px; background:#ef4444; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">⚠️ RESET STATE (Use if Stuck)</button>
                </form>

                <h4 style="color:#94a3b8; margin-top:25px; border-bottom:1px solid #334155;">Recent Events</h4>
                ${historyRows || '<p style="text-align:center; font-size:12px; color:#64748b;">No events logged.</p>'}
            </div>
        </body>
        </html>
    `);
});

// --- ACTIONS ---
app.post('/update-token', async (req, res) => {
    const token = req.body.token;
    // 🛡️ VERIFY TOKEN IMMEDIATELY
    try {
        await axios.get("https://api.upstox.com/v2/user/profile", { headers: { 'Authorization': `Bearer ${token}` }});
        ACCESS_TOKEN = token;
        res.redirect('/');
    } catch (e) {
        res.send(`<h1 style="color:red; text-align:center;">❌ INVALID TOKEN</h1><p style="text-align:center;">Upstox rejected this token. Please generate a new one.</p><div style="text-align:center;"><a href="/">Try Again</a></div>`);
    }
});

app.post('/reset-state', async (req, res) => {
    botState = { positionType: null, entryPrice: 0, currentStop: null, totalPnL: botState.totalPnL, quantity: 0, history: botState.history };
    botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "RESET", price: 0, id: "User Manual Reset", status: "OK" });
    await saveState();
    res.redirect('/');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Dashboard Live on ${PORT}`));
