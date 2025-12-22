const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; // ✅ Silver Mic Feb 2026

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE" : "🔴 WAITING FOR TOKEN";
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Bot (Feb 2026)</h1>
            <h2>Status: ${status}</h2>
            <p>Contract: ${INSTRUMENT_KEY}</p>
            <form action="/update-token" method="POST">
                <p>Paste Upstox Access Token:</p>
                <input type="text" name="token" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px;">START TRADING</button>
            </form>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.send("<h1>Token Updated! 🚀</h1><a href='/'>Go Back</a>");
});

// --- 2. DATE HELPER (Required for History) ---
function getDates() {
    const today = new Date();
    const past = new Date();
    past.setDate(today.getDate() - 10); // Fetch last 10 days (plenty for EMA)
    
    return {
        to: today.toISOString().split('T')[0],
        from: past.toISOString().split('T')[0]
    };
}

// --- 3. TRADING ENGINE ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const dates = getDates();
        // SWITCHED TO HISTORY API (Last 10 Days)
        const url = `https://api.upstox.com/v2/historical-candle/${INSTRUMENT_KEY}/15minute/${dates.to}/${dates.from}`;
        
        const response = await axios.get(url, {
            headers: { 'Accept': 'application/json' }
        });

        // Handle Data
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            console.log("⚠️ No Data. Market Closed?");
            return;
        }

        // Calculate Indicators
        const closes = candles.map(c => c[4]).reverse(); // Oldest first
        const lastPrice = closes[closes.length - 1];

        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // --- SIGNALS ---
        if (currentRSI < 30 && lastPrice > currentEMA) console.log("🚀 BUY SIGNAL!");
        if (currentRSI > 70 && lastPrice < currentEMA) console.log("🔻 SELL SIGNAL!");

    } catch (error) {
        console.error("❌ Error:", error.message);
    }

}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
