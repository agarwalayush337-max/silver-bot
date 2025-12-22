const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; // Silver Mic (Feb 2026)

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE (10s Refresh)" : "🔴 OFFLINE";
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Bot (Turbo Mode)</h1>
            <h2>Status: ${status}</h2>
            <p>Target: ${INSTRUMENT_KEY}</p>
            <form action="/update-token" method="POST">
                <p>Paste Access Token:</p>
                <input type="text" name="token" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px; font-weight: bold; background: #FF5722; color: white; border: none; cursor: pointer;">START FAST BOT</button>
            </form>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    const newToken = req.body.token;
    if (newToken && newToken.length > 20) {
        ACCESS_TOKEN = newToken;
        console.log("✅ Token Updated! Starting 10s Loop...");
        res.send("<h1>Token Received! 🚀</h1><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token.");
    }
});

// --- 2. TRADING ENGINE (10 SECOND LOOP) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        // Intraday API (Correct Price)
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/30minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // Data Handling
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            console.log("⚠️ No Data.");
            return;
        }

        // Prepare Data
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // --- INDICATORS ---
        // RSI 14
        const rsi = RSI.calculate({ period: 14, values: closes });
        
        // 🔥 EMA 20 (Faster Calculation, fixes "Loading")
        const ema = EMA.calculate({ period: 20, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // Log
        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA(20): ${currentEMA ? currentEMA.toFixed(2) : 'Calculating...'}`);

        // Signals
        if (currentRSI < 30 && lastPrice > currentEMA) console.log("🚀 BUY SIGNAL!");
        if (currentRSI > 70 && lastPrice < currentEMA) console.log("🔻 SELL SIGNAL!");

    } catch (error) {
        if (error.response && error.response.status === 401) {
            ACCESS_TOKEN = null;
            console.log("❌ Token Expired.");
        } else {
            // Ignore minor network glitches to keep loop running fast
            console.error("⚠️ Network glitch:", error.message);
        }
    }

}, 10 * 1000); // ✅ 10 Seconds Refresh

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



