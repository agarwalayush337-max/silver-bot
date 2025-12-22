const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;

// ✅ CORRECT SILVER KEY (As you requested)
const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB DASHBOARD (The "Face" of the Bot) ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE & WATCHING SILVER" : "🔴 OFFLINE (Waiting for Token)";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Mic Agent (Feb Contract)</h1>
            <h2>Status: ${status}</h2>
            <p>Target Key: ${INSTRUMENT_KEY}</p>
            <hr/>
            <form action="/update-token" method="POST">
                <h3>Daily Setup:</h3>
                <p>1. Login to Upstox API -> Get Code -> Get Access Token</p>
                <p>2. Paste Token Below:</p>
                <input type="text" name="token" placeholder="Paste Access Token here" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px; font-weight: bold; cursor: pointer;">START TRADING</button>
            </form>
        </div>
    `);
});

// --- 2. TOKEN HANDLER ---
app.post('/update-token', (req, res) => {
    const newToken = req.body.token;
    if (newToken && newToken.length > 20) {
        ACCESS_TOKEN = newToken;
        console.log("✅ Token Received! Silver Agent Starting...");
        res.send("<h1>Token Updated! 🚀</h1><p>Check the Render Logs to see price updates.</p><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token. Please go back and paste the full token.");
    }
});

// --- 3. TRADING ENGINE (The "Brain") ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // We use the INTRADAY API (Last 5-10 days). It is faster and safer.
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${INSTRUMENT_KEY}/30minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // --- ROBUST DATA HANDLING (Fixes 'map is not a function') ---
        let candles = [];
        
        // Scenario A: Data is inside 'data.candles' (Common for Commodities)
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } 
        // Scenario B: Data is directly in 'data' (Common for Stocks)
        else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } 
        else {
            console.log("⚠️ Market Closed or No Data. Waiting...");
            return;
        }

        // Upstox Intraday returns [Timestamp, Open, High, Low, Close, Vol, OI]
        // We need 'Close' (Index 4). 
        // API returns NEWEST candle first (Index 0). We reverse it for calculation.
        
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // --- INDICATORS ---
        // 14 Period RSI, 50 Period EMA
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // --- LOGIC ---
        console.log(`🔎 Silver (${INSTRUMENT_KEY}): ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'N/A'}`);

        // BUY LOGIC
        if (currentRSI < 30 && lastPrice > currentEMA) {
            console.log("🚀 BUY SIGNAL: Oversold in Uptrend! (Simulated)");
        }
        
        // SELL LOGIC
        if (currentRSI > 70 && lastPrice < currentEMA) {
            console.log("🔻 SELL SIGNAL: Overbought in Downtrend! (Simulated)");
        }

    } catch (error) {
        // Handle Token Expiry
        if (error.response && error.response.status === 401) {
            console.error("❌ Token Expired! Please update it on the website.");
            ACCESS_TOKEN = null;
        } else {
            console.error("❌ Error:", error.message);
        }
    }

}, 60 * 1000); // Check every 60 seconds

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
