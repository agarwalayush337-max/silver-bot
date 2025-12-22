const express = require('express');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305";

// --- STATE MANAGEMENT ---
let isPositionOpen = false;
let entryPrice = 0;

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 40px;">
            <h1>🤖 Professional Silver V3 Bot</h1>
            <h3>Status: ${ACCESS_TOKEN ? "🟢 ONLINE" : "🔴 OFFLINE"}</h3>
            <form action="/update-token" method="POST">
                <input type="text" name="token" placeholder="Paste Access Token" style="width: 350px; padding: 10px;">
                <button type="submit">START BOT</button>
            </form>
            <p>Bot is combining: <b>Intraday V3</b> + <b>Historical V3</b></p>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

// --- TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        
        // Dates for Historical (Fixing the 208k price issue)
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const past = new Date(today);
        past.setDate(today.getDate() - 20); // 20 days for EMA 50

        const toDate = tomorrow.toISOString().split('T')[0];
        const fromDate = past.toISOString().split('T')[0];

        // 🔗 THE TWO MAGIC LINKS
        const historicalUrl = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/15/${toDate}/${fromDate}`;
        const intradayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/minutes/15`;

        const headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' };

        // Fetch both in parallel for speed
        const [histRes, intraRes] = await Promise.all([
            axios.get(historicalUrl, { headers }),
            axios.get(intradayUrl, { headers })
        ]);

        const historicalCandles = histRes.data.data.candles || [];
        const intradayCandles = intraRes.data.data.candles || [];

        // 🧩 MERGE AND DEDUPLICATE
        // We use a Map keyed by timestamp to ensure uniqueness
        const combinedMap = new Map();
        
        // Add historical first, then intraday (intraday will overwrite if timestamps overlap)
        historicalCandles.forEach(c => combinedMap.set(c[0], c));
        intradayCandles.forEach(c => combinedMap.set(c[0], c));

        // Sort: Oldest to Newest for Indicator calculation
        const sortedCandles = Array.from(combinedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
        
        const closes = sortedCandles.map(c => c[4]);
        const lastPrice = closes[closes.length - 1];

        // --- CALCULATE INDICATORS ---
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        console.log(`🔎 Live Price: ₹${lastPrice} | RSI: ${currentRSI.toFixed(2)} | EMA(50): ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // --- TRADING LOGIC ---
        if (!isPositionOpen && currentRSI < 30 && lastPrice > currentEMA) {
            console.log("🚀 SIGNAL: BUY EXECUTED");
            isPositionOpen = true;
            entryPrice = lastPrice;
        } else if (isPositionOpen && (currentRSI > 70 || (lastPrice - entryPrice) > 300)) {
            console.log(`💰 SIGNAL: SELL EXECUTED | Profit: ₹${lastPrice - entryPrice}`);
            isPositionOpen = false;
        }

    } catch (e) {
        console.error("Bot Error:", e.message);
    }
}, 10000); // 10s Refresh

app.listen(3000, () => console.log("Combined V3 Bot Ready"));
