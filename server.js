const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;

// ✅ CORRECT SILVER KEY (Confirmed by you)
const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE & TRADING" : "🔴 OFFLINE (Waiting for Token)";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Mic Bot (Feb 2026)</h1>
            <h2>Status: ${status}</h2>
            <p><strong>Contract:</strong> ${INSTRUMENT_KEY}</p>
            <hr/>
            <form action="/update-token" method="POST">
                <h3>Daily Login:</h3>
                <p>1. Get Access Token from Upstox</p>
                <p>2. Paste Token Below:</p>
                <input type="text" name="token" placeholder="Paste Access Token here" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px; font-weight: bold; cursor: pointer; background-color: #4CAF50; color: white; border: none;">START TRADING</button>
            </form>
        </div>
    `);
});

// --- 2. TOKEN RECEIVER ---
app.post('/update-token', (req, res) => {
    const newToken = req.body.token;
    if (newToken && newToken.length > 20) {
        ACCESS_TOKEN = newToken;
        console.log("✅ Token Updated! Bot Starting...");
        res.send("<h1>Token Received! 🚀</h1><p>Check Render Logs for Price.</p><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token. Please try again.");
    }
});

// --- 3. TRADING ENGINE (Verified Working Version) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // ✅ URL ENCODING: Fixes any potential 400 Errors with special characters
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        
        // ✅ INTRADAY API: Validated by you as the only one giving correct price
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/30minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // --- DATA HANDLING ---
        let candles = [];
        
        // Standard Upstox V2/V3 Data Extraction
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            console.log("⚠️ No Data Received (Market Closed?)");
            return;
        }

        // --- CALCULATIONS ---
        // Reverse to get Oldest -> Newest for indicators
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // Indicators (RSI 14, EMA 50)
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // --- LOG OUTPUT ---
        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // --- SIGNALS ---
        if (currentRSI < 30 && lastPrice > currentEMA) {
            console.log("🚀 BUY SIGNAL DETECTED!");
        }
        
        if (currentRSI > 70 && lastPrice < currentEMA) {
            console.log("🔻 SELL SIGNAL DETECTED!");
        }

    } catch (error) {
        // Smart Error Log
        if (error.response && error.response.status === 401) {
            console.error("❌ Token Expired. Please update on website.");
            ACCESS_TOKEN = null;
        } else {
            console.error("❌ Bot Error:", error.message);
        }
    }

}, 60 * 1000); // Run every minute

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
