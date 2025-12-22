const express = require('express');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- STRATEGY MEMORY ---
let isPositionOpen = false;
let entryPrice = 0;
let totalProfit = 0;

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 AGGRESSIVE MODE ON" : "🔴 OFFLINE";
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 40px; background: #121212; color: white; min-height: 100vh;">
            <h1>⚡ Silver Turbo Scalper (V3)</h1>
            <p>5-Min | RSI(7) | EMA 9/21 | Target: ₹300</p>
            <div style="border: 1px solid #333; padding: 20px; border-radius: 10px; background: #1e1e1e;">
                <h3>Status: ${status}</h3>
                <p>Position: <span style="color: ${isPositionOpen ? '#4CAF50' : '#ff9800'}">${isPositionOpen ? 'OPEN' : 'WAITING'}</span></p>
                <p>Current Session Profit: <b style="font-size: 24px;">₹${totalProfit}</b></p>
            </div>
            <br>
            <form action="/update-token" method="POST">
                <input type="text" name="token" placeholder="Paste Access Token" style="width: 300px; padding: 12px; border-radius: 5px;">
                <button type="submit" style="padding: 12px 25px; background: #2196F3; color: white; border: none; border-radius: 5px; cursor: pointer;">START TRADING</button>
            </form>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    totalProfit = 0; // Reset profit for new session
    res.redirect('/');
});

// --- 2. TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const past = new Date(today); past.setDate(today.getDate() - 10);

        const toDate = tomorrow.toISOString().split('T')[0];
        const fromDate = past.toISOString().split('T')[0];

        // 🔗 FETCH BOTH STREAMS
        const headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' };
        const histUrl = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/5/${toDate}/${fromDate}`;
        const intraUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/minutes/5`;

        const [histRes, intraRes] = await Promise.all([
            axios.get(histUrl, { headers }).catch(() => ({ data: { data: { candles: [] } } })),
            axios.get(intraUrl, { headers }).catch(() => ({ data: { data: { candles: [] } } }))
        ]);

        const combinedMap = new Map();
        (histRes.data.data.candles || []).forEach(c => combinedMap.set(c[0], c));
        (intraRes.data.data.candles || []).forEach(c => combinedMap.set(c[0], c));

        const sorted = Array.from(combinedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
        const closes = sorted.map(c => c[4]);
        const lastPrice = closes[closes.length - 1];

        // --- AGGRESSIVE INDICATORS ---
        const rsi7 = RSI.calculate({ period: 7, values: closes });
        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });

        const curRSI = rsi7[rsi7.length - 1];
        const curE9 = ema9[ema9.length - 1];
        const curE21 = ema21[ema21.length - 1];

        console.log(`📊 Price: ${lastPrice} | RSI(7): ${curRSI.toFixed(2)} | E9: ${curE9.toFixed(2)}`);

        // --- TRADING LOGIC ---
        
        // 1. ENTRY (BUY ONLY)
        if (!isPositionOpen) {
            // Signal: RSI is oversold (<25) AND Price is above 21 EMA (Uptrend) AND Price breaks 9 EMA
            if (curRSI < 25 && lastPrice > curE21 && lastPrice > curE9) {
                console.log(`🚀 AGGRESSIVE BUY @ ${lastPrice}`);
                isPositionOpen = true;
                entryPrice = lastPrice;
            }
        } 
        
        // 2. EXIT (PROFIT OR LOSS)
        else {
            const currentPnl = lastPrice - entryPrice;

            // Take Profit (₹300) OR RSI peaks (>75) OR Trailing Stop (Price drops below 9 EMA)
            if (currentPnl >= 300 || curRSI > 75 || lastPrice < curE9) {
                console.log(`💰 EXIT @ ${lastPrice} | PnL: ${currentPnl}`);
                totalProfit += currentPnl;
                isPositionOpen = false;
                entryPrice = 0;
            }
            
            // Fixed Stop Loss (₹150)
            else if (currentPnl <= -150) {
                console.log(`🛑 STOP LOSS @ ${lastPrice} | PnL: ${currentPnl}`);
                totalProfit += currentPnl;
                isPositionOpen = false;
                entryPrice = 0;
            }
        }

    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}, 10000); // Check every 10 seconds

app.listen(3000, () => console.log("Turbo Scalper Active"));
