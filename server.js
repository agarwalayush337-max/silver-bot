const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
let INSTRUMENT_KEY = "MCX_FO|458305"; // Default (Feb 2026)

// --- 1. DASHBOARD ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE" : "🔴 WAITING FOR TOKEN";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 20px;">
            <h1>🤖 Silver Bot (Final Version)</h1>
            <h3>Status: ${status}</h3>
            <p><strong>Trading Contract:</strong> ${INSTRUMENT_KEY}</p>
            
            <div style="background: #e8f5e9; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 1: Start Bot</h3>
                <form action="/update-token" method="POST">
                    <input type="text" name="token" placeholder="Paste Access Token" style="width: 300px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #4CAF50; color: white; border: none;">Start</button>
                </form>
            </div>

            <div style="background: #e3f2fd; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 2: Find Correct Price</h3>
                <p>If price is wrong, search for "SILVER" or "SILVERM" below:</p>
                <form action="/search" method="GET">
                    <input type="text" name="q" placeholder="Symbol (e.g. SILVERMIC)" style="width: 200px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #2196F3; color: white; border: none;">Search</button>
                </form>
            </div>

            <div style="background: #fff3e0; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 3: Change Contract</h3>
                <form action="/set-key" method="POST">
                    <input type="text" name="key" placeholder="Paste Key (e.g. MCX_FO|458305)" style="width: 300px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #ff9800; color: white; border: none;">Update</button>
                </form>
            </div>
        </div>
    `);
});

// --- 2. HANDLERS ---
app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

app.post('/set-key', (req, res) => {
    INSTRUMENT_KEY = req.body.key;
    console.log("✅ Contract Updated to:", INSTRUMENT_KEY);
    res.redirect('/');
});

// --- 3. FIXED SEARCH API (Solves 404 Error) ---
app.get('/search', async (req, res) => {
    if (!ACCESS_TOKEN) return res.send("❌ Error: Please enter Access Token first!");
    
    try {
        const query = req.query.q || "SILVERMIC";
        // FIX: Correct parameter is 'search_key', not 'q'
        const url = `https://api.upstox.com/v2/market/search/instrument?search_key=${query}&segment=MCX_FO`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        const list = response.data.data;
        let html = `<h2>Search Results for "${query}"</h2>
                    <p>Copy the <strong>Key</strong> that matches your broker's Expiry/Name.</p>
                    <table border="1" cellpadding="10" style="border-collapse: collapse; width: 100%;">
                    <tr><th>Symbol</th><th>Expiry</th><th>Key (Copy This)</th></tr>`;
        
        list.forEach(item => {
            // Only show Futures
            if(item.instrument_type === "FUTCOM") {
                html += `<tr>
                    <td>${item.trading_symbol}</td>
                    <td>${item.expiry}</td>
                    <td><code>${item.instrument_key}</code></td>
                </tr>`;
            }
        });
        html += "</table><br><a href='/'>Go Back</a>";
        res.send(html);

    } catch (e) {
        res.send("Search Error: " + (e.response ? JSON.stringify(e.response.data) : e.message));
    }
});

// --- 4. TRADING LOOP (Solves 400 Error) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // FIX: Encode the pipe symbol '|' to '%7C' to prevent 400 Bad Request
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        
        // Use Intraday API for 15minute support
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/15minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        // Smart Data Extraction
        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            return; 
        }

        // Indicators
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        console.log(`🔎 ${INSTRUMENT_KEY}: ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // Logic
        if (currentRSI < 30 && lastPrice > currentEMA) console.log("🚀 BUY SIGNAL");
        if (currentRSI > 70 && lastPrice < currentEMA) console.log("🔻 SELL SIGNAL");

    } catch (error) {
        // Log clean error message
        console.error("Bot Error:", error.response ? error.response.status : error.message);
    }

}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
