const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;

// ✅ CORRECT KEY: Silver Mic (Feb 27, 2026 Expiry)
const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE & TRADING" : "🔴 OFFLINE (Waiting for Token)";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Mic Agent (Feb 2026)</h1>
            <h2>Status: ${status}</h2>
            <p><strong>Contract:</strong> ${INSTRUMENT_KEY}</p>
            <hr/>
            <form action="/update-token" method="POST">
                <h3>Daily Login:</h3>
                <p>1. Get Access Token from Upstox Login</p>
                <p>2. Paste it below to start the bot:</p>
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
        console.log("✅ Token Updated! Silver Agent is starting...");
        res.send("<h1>Token Received! 🚀</h1><p>The bot is now active. Check Render Logs.</p><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token. Please try again.");
    }
});

// --- 3. TRADING ENGINE (Runs every 60 seconds) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // FIX: Changed to '15minute' to get more candles (Fixes EMA: N/A)
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${INSTRUMENT_KEY}/15minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // --- SMART DATA HANDLING ---
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles; // Commodity Format
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data; // Stock Format
        } else {
            console.log("⚠️ Market Closed or No Data Received.");
            return;
        }

        // Prepare Data (Reverse to get Oldest -> Newest for indicators)
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // --- INDICATORS ---
        // RSI (14) and EMA (50)
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // --- LOG OUTPUT ---
        console.log(`🔎 Silver (${INSTRUMENT_KEY}): ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Waiting...'}`);

        // --- TRADING STRATEGY (Simulated) ---
        
        // 1. BUY SIGNAL (RSI Oversold + Price above EMA)
        if (currentRSI < 30 && currentEMA && lastPrice > currentEMA) {
            console.log("🚀 BUY SIGNAL DETECTED! (Condition: RSI < 30 & Price > EMA)");
        }
        
        // 2. SELL SIGNAL (RSI Overbought + Price below EMA)
        if (currentRSI > 70 && currentEMA && lastPrice < currentEMA) {
            console.log("🔻 SELL SIGNAL DETECTED! (Condition: RSI > 70 & Price < EMA)");
        }

    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.error("❌ Token Expired. Please re-login on the website.");
            ACCESS_TOKEN = null;
        } else {
            console.error("❌ Bot Error:", error.message);
        }
    }

}, 60 * 1000); // Run every minute

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
