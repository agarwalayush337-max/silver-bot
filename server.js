const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; // Silver Mic Feb 2026

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

// --- 2. DATE HELPER ---
function getDates() {
    const today = new Date();
    const past = new Date();
    past.setDate(today.getDate() - 15); // 15 Days of history
    
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
        
        // 🔥 CRITICAL FIX: URL Encoding the Key
        // The "|" symbol in MCX_FO|458305 often breaks requests if not encoded
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);

        // ✅ URL STRUCTURE: We use '30minute' because '15minute' often fails on Historical
        // If you strictly need 15min, change '30minute' to '15minute' below
        const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/30minute/${dates.to}/${dates.from}`;
        
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
        const closes = candles.map(c => c[4]).reverse();
        const lastPrice = closes[closes.length - 1];

        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // LOG OUTPUT
        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Calculating...'}`);

        // SIGNALS
        if (currentRSI < 30 && lastPrice > currentEMA) console.log("🚀 BUY SIGNAL!");
        if (currentRSI > 70 && lastPrice < currentEMA) console.log("🔻 SELL SIGNAL!");

    } catch (error) {
        // If 400 error happens again, it prints WHY
        console.error("❌ API Error:", error.response ? error.response.status : error.message);
        if (error.response && error.response.status === 400) {
             console.error("👉 Tip: Try changing '30minute' to 'day' or check the Dates.");
        }
    }

}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
