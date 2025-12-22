const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
// Default Key (We will change this using the Search Feature)
let INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB DASHBOARD (With Search!) ---
app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 ONLINE" : "🔴 WAITING FOR TOKEN";
    
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 20px;">
            <h1>🤖 Silver Smart Bot</h1>
            <h3>Status: ${status}</h3>
            <p><strong>Current Contract:</strong> ${INSTRUMENT_KEY}</p>
            
            <div style="background: #f4f4f4; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 1: Login</h3>
                <form action="/update-token" method="POST">
                    <input type="text" name="token" placeholder="Paste Access Token" style="width: 300px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #28a745; color: white; border: none;">Start Bot</button>
                </form>
            </div>

            <div style="background: #e3f2fd; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 2: Fix "False Price"</h3>
                <p>Search for the correct contract (e.g. SILVERMIC, SILVERM)</p>
                <form action="/search" method="GET">
                    <input type="text" name="q" placeholder="Symbol (e.g. SILVERMIC)" style="width: 200px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #007bff; color: white; border: none;">Search</button>
                </form>
            </div>
            
            <div style="background: #fff3e0; padding: 15px; margin: 10px; border-radius: 8px;">
                <h3>Step 3: Update Key</h3>
                <form action="/set-key" method="POST">
                    <input type="text" name="key" placeholder="Paste New Key (e.g. MCX_FO|12345)" style="width: 300px; padding: 10px;">
                    <button type="submit" style="padding: 10px 20px; background: #ff9800; color: white; border: none;">Update Key</button>
                </form>
            </div>
        </div>
    `);
});

// --- 2. HELPERS ---
app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

app.post('/set-key', (req, res) => {
    INSTRUMENT_KEY = req.body.key;
    console.log("✅ Contract Updated to:", INSTRUMENT_KEY);
    res.redirect('/');
});

// --- 3. SEARCH API (Finds the Real Price Key) ---
app.get('/search', async (req, res) => {
    if (!ACCESS_TOKEN) return res.send("❌ Please enter Access Token first!");
    
    try {
        const query = req.query.q || "SILVERMIC";
        const url = `https://api.upstox.com/v2/market/search/instrument?q=${query}&segment=MCX_FO`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        const list = response.data.data;
        let html = `<h2>Search Results for "${query}"</h2><ul>`;
        
        list.forEach(item => {
            // Filter only Futures
            if(item.instrument_type === "FUTCOM") {
                html += `<li style="margin: 10px 0;">
                    <strong>${item.trading_symbol}</strong> (Expiry: ${item.expiry})<br>
                    Key: <code>${item.instrument_key}</code> <br>
                    <button onclick="navigator.clipboard.writeText('${item.instrument_key}')">Copy Key</button>
                </li>`;
            }
        });
        html += "</ul><a href='/'>Go Back</a>";
        res.send(html);

    } catch (e) {
        res.send("Error searching: " + e.message);
    }
});

// --- 4. TRADING ENGINE (15 MINUTE - INTRADAY) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        // ✅ We use INTRADAY API because it supports '15minute'
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${INSTRUMENT_KEY}/15minute`;
        
        const response = await axios.get(url, {
            headers: { 
                'Accept': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            }
        });

        let candles = [];
        if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
            candles = response.data.data.candles;
        } else if (response.data && Array.isArray(response.data.data)) {
            candles = response.data.data;
        } else {
            return;
        }

        // Prepare Data
        const closes = candles.map(c => c[4]).reverse(); 
        const lastPrice = closes[closes.length - 1];

        // Indicators
        const rsi = RSI.calculate({ period: 14, values: closes });
        const ema = EMA.calculate({ period: 50, values: closes });

        const currentRSI = rsi[rsi.length - 1];
        const currentEMA = ema[ema.length - 1];

        console.log(`🔎 ${INSTRUMENT_KEY}: ₹${lastPrice} | RSI: ${currentRSI ? currentRSI.toFixed(2) : 'N/A'} | EMA: ${currentEMA ? currentEMA.toFixed(2) : 'Loading...'}`);

        // Signals
        if (currentRSI < 30 && lastPrice > currentEMA) console.log("🚀 BUY SIGNAL!");
        if (currentRSI > 70 && lastPrice < currentEMA) console.log("🔻 SELL SIGNAL!");

    } catch (error) {
        console.error("❌ Bot Error:", error.message);
    }

}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
