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
            <h1>🤖 Silver Mic Bot (Stable)</h1>
            <h2>Status: ${status}</h2>
            <p><strong>Contract:</strong> ${INSTRUMENT_KEY}</p>
            <hr/>
            <form action="/update-token" method="POST">
                <h3>Daily Login:</h3>
                <p>Paste Upstox Access Token below:</p>
                <input type="text" name="token" placeholder="Paste Access Token here" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px; font-weight: bold; cursor: pointer; background-color: #2196F3; color: white; border: none;">START BOT</button>
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
        res.send("<h1>Token Received! 🚀</h1><p>Check Logs for Price & EMA.</p><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token.");
    }
});

// --- 3. HELPER: Get Dates for History ---
function getDates() {
    const today = new Date();
    const past = new Date();
    past.setDate(today.getDate() - 30); // Fetch 30 Days (Guarantees EMA works)
    
    return {
        to: today.toISOString().split('T')[0],
        from: past.toISOString().split('T')[0]
    };
}

// --- 4. TRADING ENGINE (Robust Mode) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const dates = getDates();
        
        // 🔥 FIX 1: URL Encode the Key (Fixes broken links)
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);

        // 🔥 FIX 2: Use '30minute' (Fixes Error 400)
        // Upstox Historical API REJECTS '15minute'. We must use '30minute'.
        const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/30minute/${dates.to}/${dates.from}`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}` // Fixes potential 401
            }
        });

        // --- DATA HANDLING ---
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            console.log("⚠️ No Data. Market Closed or Holiday.");
            return;
        }

        // Prepare Data (Reverse to get Oldest -> Newest)
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // --- INDICATORS ---
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // --- LOG OUTPUT ---
        // This will now show REAL numbers, no N/A, no Errors.
        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA.toFixed(2)}`);

        // --- SIGNALS ---
        if (currentRSI < 30 && lastPrice > currentEMA) {
            console.log("🚀 BUY SIGNAL DETECTED!");
        }
        
        if (currentRSI > 70 && lastPrice < currentEMA) {
            console.log("🔻 SELL SIGNAL DETECTED!");
        }

    } catch (error) {
        // Smart Error Handling
        if (error.response) {
            console.error(`❌ API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
            if (error.response.status === 401) ACCESS_TOKEN = null; // Token Expired
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
