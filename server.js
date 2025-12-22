const express = require('express');
const axios = require('axios');
const { RSI, EMA, VWAP } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305";

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 40px;">
            <h1>📊 Silver Scalp Backtester</h1>
            <p>Strategy: 5-Min | VWAP | RSI(7) | EMA 9/20 Cross</p>
            <form action="/run-backtest" method="POST">
                <input type="text" name="token" placeholder="Paste Access Token" style="width: 350px; padding: 10px;">
                <br><br>
                <button type="submit" style="padding: 15px 30px; background: #673AB7; color: white; border: none; cursor: pointer; font-weight: bold;">RUN 15-DAY BACKTEST</button>
            </form>
            <div id="results"></div>
        </div>
    `);
});

app.post('/run-backtest', async (req, res) => {
    ACCESS_TOKEN = req.body.token;
    if (!ACCESS_TOKEN) return res.send("Missing Token");

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const past = new Date(today); past.setDate(today.getDate() - 15);

        const toDate = tomorrow.toISOString().split('T')[0];
        const fromDate = past.toISOString().split('T')[0];

        // Fetch 5-Minute Candles (V3 Historical)
        const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/5/${toDate}/${fromDate}`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });

        const candles = response.data.data.candles.reverse(); // Oldest to Newest
        
        // --- PREPARE DATA ---
        const high = candles.map(c => c[2]);
        const low = candles.map(c => c[3]);
        const close = candles.map(c => c[4]);
        const volume = candles.map(c => c[5]);

        // --- CALCULATE INDICATORS ---
        const rsi = RSI.calculate({ period: 7, values: close });
        const ema9 = EMA.calculate({ period: 9, values: close });
        const ema20 = EMA.calculate({ period: 20, values: close });
        const vwap = VWAP.calculate({ high, low, close, volume });

        // Padding indicators to match candle array length
        const offset = candles.length - rsi.length;
        
        let balance = 0;
        let trades = [];
        let inPosition = false;
        let entryPrice = 0;

        // --- SIMULATION LOOP ---
        for (let i = 50; i < candles.length; i++) {
            const price = close[i];
            const currentRsi = rsi[i - offset];
            const currentE9 = ema9[i - (candles.length - ema9.length)];
            const currentE20 = ema20[i - (candles.length - ema20.length)];
            const currentVwap = vwap[i - (candles.length - vwap.length)];

            // BUY LOGIC: Above VWAP + RSI Oversold + EMA Cross
            if (!inPosition && price > currentVwap && currentRsi < 30 && currentE9 > currentE20) {
                inPosition = true;
                entryPrice = price;
                trades.push({ type: 'BUY', price: entryPrice, time: candles[i][0] });
            } 
            // SELL LOGIC: RSI Overbought or EMA Reverse or 200 pt Target
            else if (inPosition) {
                const profit = price - entryPrice;
                if (currentRsi > 70 || currentE9 < currentE20 || profit > 250 || profit < -150) {
                    balance += profit;
                    inPosition = false;
                    trades.push({ type: 'SELL', price, time: candles[i][0], profit });
                }
            }
        }

        // --- DISPLAY RESULTS ---
        let html = `<h2>Backtest Results (Last 15 Days)</h2>`;
        html += `<p>Total Trades: ${trades.length / 2}</p>`;
        html += `<h1 style="color: ${balance >= 0 ? 'green' : 'red'}">Net Profit: ₹${balance.toFixed(2)}</h1>`;
        html += `<table border="1" style="width:100%; text-align:left; border-collapse:collapse;">
                    <tr><th>Action</th><th>Price</th><th>Time</th><th>Profit</th></tr>`;
        
        trades.forEach(t => {
            html += `<tr><td>${t.type}</td><td>${t.price}</td><td>${t.time}</td><td>${t.profit || '-'}</td></tr>`;
        });
        html += `</table><br><a href="/">Back</a>`;
        
        res.send(html);

    } catch (e) {
        res.send("Error: " + e.message);
    }
});

app.listen(3000);
