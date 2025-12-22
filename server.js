const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
// Note: Upstox "Instrument Key" for Silver Mic. Update this monthly!
// Format: MCX_FO|{instrument_token}
// You can find the correct key in the Upstox dashboard or instrument list.
// For now, we will use a placeholder that you must verify.
const INSTRUMENT_KEY = "MCX_FO|SILVERMIC26FEB"; 

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 TRADING ACTIVE" : "🔴 WAITING FOR TOKEN";
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Agent</h1>
            <h2>Status: ${status}</h2>
            <form action="/update-token" method="POST">
                <p><strong>Step 1:</strong> <a href="https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=YOUR_API_KEY_HERE&redirect_uri=http://localhost:3000" target="_blank">Login to Upstox</a> (Get 'code' from URL)</p>
                <p><strong>Step 2:</strong> Paste Access Token below:</p>
                <input type="text" name="token" placeholder="Paste Access Token" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px;">Start Bot</button>
            </form>
        </div>
    `);
});

// --- 2. TOKEN RECEIVER ---
app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    console.log("✅ Token Updated! Bot is starting...");
    res.send("<h1>Token Received! 🚀</h1><a href='/'>Go Back</a>");
});

// --- 3. TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // A. Fetch Data directly via API (No SDK needed)
        const url = `https://api.upstox.com/v2/historical-candle/${INSTRUMENT_KEY}/15minute/${getDateString(0)}/${getDateString(5)}`;
        const response = await axios.get(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.data || !response.data.data || response.data.data.length === 0) {
            console.log("⚠️ No data. Market closed or wrong Symbol.");
            return;
        }

        // B. Calculate Indicators
        // Upstox returns data as [timestamp, open, high, low, close, vol, oi]
        const candles = response.data.data; 
        const closes = candles.map(c => c[4]).reverse(); // Reverse to get oldest-to-newest for calculation
        const lastPrice = closes[closes.length - 1];

        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        console.log(`🔎 Price: ${lastPrice} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA.toFixed(2)}`);

    } catch (error) {
        console.error("❌ Error:", error.response ? error.response.data : error.message);
        if (error.response && error.response.status === 401) {
            ACCESS_TOKEN = null; // Token expired
        }
    }
}, 60000); // Run every 60 seconds

function getDateString(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().split('T')[0];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
