const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; // Silver Mic (Feb 2026)

// --- STATE MANAGEMENT (Paper Trading Memory) ---
let isPositionOpen = false;
let entryPrice = 0;
let totalProfit = 0;

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE (V3 API)" : "🔴 OFFLINE";
    const posColor = isPositionOpen ? "green" : "grey";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>🤖 Silver Bot (V3 Professional)</h1>
            <h3>Status: ${status}</h3>
            
            <div style="border: 1px solid #ddd; padding: 20px; display: inline-block; border-radius: 10px; background: #f9f9f9;">
                <p><strong>Strategy:</strong> 15-Minute | RSI(14) | EMA(50)</p>
                <p style="color: ${posColor}; font-weight: bold;">
                    Position: ${isPositionOpen ? `OPEN @ ₹${entryPrice}` : "WAITING"}
                </p>
                <p><strong>Total Simulated Profit:</strong> ₹${totalProfit}</p>
            </div>
            
            <hr/>
            <form action="/update-token" method="POST">
                <p>Paste Access Token:</p>
                <input type="text" name="token" style="width: 300px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 10px 20px; font-weight: bold; background: #2196F3; color: white; border: none; cursor: pointer;">START V3 BOT</button>
            </form>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    const newToken = req.body.token;
    if (newToken && newToken.length > 20) {
        ACCESS_TOKEN = newToken;
        console.log("✅ Token Received! Switching to V3 API...");
        // Reset state on restart
        isPositionOpen = false;
        entryPrice = 0;
        res.send("<h1>Token Updated! 🚀</h1><a href='/'>Go Back</a>");
    } else {
        res.send("❌ Invalid Token.");
    }
});

// --- 2. HELPER: Get Dates for V3 API ---
function getDates() {
    const today = new Date();
    const past = new Date();
    past.setDate(today.getDate() - 15); // Fetch 15 days (Plenty for EMA 50)
    
    return {
        to: today.toISOString().split('T')[0],
        from: past.toISOString().split('T')[0]
    };
}

// --- 3. TRADING ENGINE (10s Loop) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const dates = getDates();
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);

        // 🔥 UPSTOX V3 API ENDPOINT (The Critical Fix)
        // Format: /v3/historical-candle/{key}/minutes/15/{to}/{from}
        const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/15/${dates.to}/${dates.from}`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // --- DATA HANDLING ---
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else {
            // V3 sometimes returns empty data if market is closed/holiday
            // console.log("Waiting for data..."); 
            return;
        }

        // Prepare Data (Reverse: Oldest -> Newest)
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // --- INDICATORS ---
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes }); // EMA 50 works now!

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        // Log
        console.log(`🔎 Silver: ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA(50): ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // --- LOGIC (Paper Trading) ---

        // 1. BUY SIGNAL
        if (!isPositionOpen) {
            if (currentRSI < 30 && lastPrice > currentEMA) {
                console.log(`🚀 SIMULATED BUY at ₹${lastPrice}`);
                isPositionOpen = true;
                entryPrice = lastPrice;
            }
        }
        
        // 2. SELL SIGNAL (Profit Taking / Stop Loss)
        else if (isPositionOpen) {
            const profit = lastPrice - entryPrice;

            // Sell Condition: RSI Overbought OR Good Profit (>200)
            if (currentRSI > 70 || profit > 200) {
                console.log(`💰 SIMULATED SELL at ₹${lastPrice} | Profit: ₹${profit}`);
                totalProfit += profit;
                isPositionOpen = false;
                entryPrice = 0;
            }
            // Stop Loss Condition (< -150)
            else if (profit < -150) {
                console.log(`🛑 STOP LOSS at ₹${lastPrice} | Loss: ₹${profit}`);
                totalProfit += profit;
                isPositionOpen = false;
                entryPrice = 0;
            }
        }

    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.log("❌ Token Expired. Please update on website.");
            ACCESS_TOKEN = null;
        } else {
            // Suppress minor V3 errors
            // console.error("API Error:", error.message);
        }
    }

}, 10 * 1000); // 10 Seconds Refresh

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
