const express = require('express');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 40px; background: #f4f7f6; min-height: 100vh;">
            <h1 style="color: #2c3e50;">📊 Silver Aggressive Backtester</h1>
            <p><strong>Strategy:</strong> 5-Min | RSI(7) | EMA 9 & 21 | Target: 300 | SL: 150</p>
            
            <div style="background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                <form action="/backtest" method="POST">
                    <p>Paste Access Token to Start:</p>
                    <input type="text" name="token" placeholder="Paste Access Token here" required style="width: 350px; padding: 12px; border: 1px solid #ddd; border-radius: 6px;">
                    <br><br>
                    <button type="submit" style="padding: 15px 30px; background: #e91e63; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px;">🔥 RUN AGGRESSIVE BACKTEST</button>
                </form>
            </div>
            <p style="color: #666; margin-top: 20px;">This will analyze the last 15 days of 5-minute data (~1500 candles).</p>
        </div>
    `);
});

// --- 2. BACKTEST ENGINE ---
app.post('/backtest', async (req, res) => {
    const token = req.body.token;
    if (!token) return res.send("Error: Token is missing.");

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const past = new Date(today); past.setDate(today.getDate() - 15); // 15 Days History

        const toDate = tomorrow.toISOString().split('T')[0];
        const fromDate = past.toISOString().split('T')[0];

        // Fetch 5-Minute Historical Data (V3)
        const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/5/${toDate}/${fromDate}`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });

        const candles = response.data.data.candles.reverse(); // Oldest to Newest
        const closes = candles.map(c => c[4]);

        // --- CALCULATE AGGRESSIVE INDICATORS ---
        const rsi7 = RSI.calculate({ period: 7, values: closes });
        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });

        // Offsets to align indicators with candles
        const rOffset = candles.length - rsi7.length;
        const e9Offset = candles.length - ema9.length;
        const e21Offset = candles.length - ema21.length;

        let trades = [];
        let inPosition = false;
        let entryPrice = 0;
        let netProfit = 0;
        let winCount = 0;

        // --- SIMULATION LOOP ---
        for (let i = 30; i < candles.length; i++) {
            const price = closes[i];
            const time = candles[i][0];
            const curRSI = rsi7[i - rOffset];
            const curE9 = ema9[i - e9Offset];
            const curE21 = ema21[i - e21Offset];

            // 1. BUY LOGIC
            // - Price above EMA 21 (Uptrend)
            // - RSI 7 is oversold (< 25)
            // - Price crosses above EMA 9
            if (!inPosition && curRSI < 25 && price > curE21 && price > curE9) {
                inPosition = true;
                entryPrice = price;
                trades.push({ type: 'BUY', price: entryPrice, time: time });
            } 
            
            // 2. SELL LOGIC
            else if (inPosition) {
                const pnl = price - entryPrice;

                // EXIT CONDITIONS:
                // - Target 300 pts OR RSI peaked > 75 OR Trailing SL (Price below EMA 9) OR Stop Loss -150
                if (pnl >= 300 || curRSI > 75 || price < curE9 || pnl <= -150) {
                    netProfit += pnl;
                    if (pnl > 0) winCount++;
                    inPosition = false;
                    trades.push({ type: 'SELL', price: price, time: time, pnl: pnl });
                }
            }
        }

        // --- GENERATE RESULTS TABLE ---
        let winRate = ((winCount / (trades.length / 2)) * 100).toFixed(1);
        let summaryColor = netProfit > 0 ? '#4CAF50' : '#f44336';

        let html = `
            <div style="font-family: sans-serif; padding: 20px;">
                <h1>Backtest Summary</h1>
                <div style="display: flex; gap: 20px; margin-bottom: 30px;">
                    <div style="padding: 20px; background: ${summaryColor}; color: white; border-radius: 8px; flex: 1;">
                        <small>NET PROFIT</small><br><b style="font-size: 32px;">₹${netProfit.toFixed(2)}</b>
                    </div>
                    <div style="padding: 20px; background: #2196F3; color: white; border-radius: 8px; flex: 1;">
                        <small>TOTAL TRADES</small><br><b style="font-size: 32px;">${trades.length / 2}</b>
                    </div>
                    <div style="padding: 20px; background: #9c27b0; color: white; border-radius: 8px; flex: 1;">
                        <small>WIN RATE</small><br><b style="font-size: 32px;">${winRate}%</b>
                    </div>
                </div>
                
                <h3>Trade Log (Detailed)</h3>
                <table border="1" style="width: 100%; border-collapse: collapse; text-align: left;">
                    <tr style="background: #eee;"><th>Type</th><th>Price</th><th>Time</th><th>Result (Pts)</th></tr>
        `;

        trades.forEach(t => {
            const pnlColor = t.pnl > 0 ? 'green' : (t.pnl < 0 ? 'red' : 'black');
            html += `
                <tr>
                    <td><b>${t.type}</b></td>
                    <td>${t.price}</td>
                    <td>${new Date(t.time).toLocaleString()}</td>
                    <td style="color: ${pnlColor}; font-weight: bold;">${t.pnl ? t.pnl.toFixed(2) : '-'}</td>
                </tr>
            `;
        });

        html += `</table><br><a href="/" style="text-decoration: none; background: #333; color: white; padding: 10px 20px; border-radius: 4px;">Back to Menu</a></div>`;
        
        res.send(html);

    } catch (error) {
        res.send(`<h2>Backtest Failed</h2><p>${error.message}</p><pre>${JSON.stringify(error.response?.data)}</pre>`);
    }
});

app.listen(3000, () => console.log("Backtester running on port 3000"));
