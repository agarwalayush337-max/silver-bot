const express = require('express');
const axios = require('axios');
const { RSI, EMA } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- 1. WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
            <h1 style="color: #38bdf8;">📊 Silver Turbo Backtester (V3)</h1>
            <p style="color: #94a3b8;">Strategy: 5-Min | RSI(7) | EMA 9 & 21 | Target: 300 Pts</p>
            
            <div style="background: #1e293b; padding: 30px; border-radius: 12px; display: inline-block; border: 1px solid #334155;">
                <form action="/backtest" method="POST">
                    <p>Paste Access Token to Analyze Last 15 Days:</p>
                    <input type="text" name="token" placeholder="Paste Access Token here" required style="width: 350px; padding: 12px; border-radius: 6px; border: none;">
                    <br><br>
                    <button type="submit" style="padding: 15px 35px; background: #38bdf8; color: #0f172a; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px;">RUN BACKTEST</button>
                </form>
            </div>
            <p style="color: #64748b; margin-top: 20px;">Analyzing ~1,500 candles for high-frequency patterns.</p>
        </div>
    `);
});

// --- 2. THE ANALYTICS ENGINE ---
app.post('/backtest', async (req, res) => {
    const token = req.body.token;
    if (!token) return res.send("Error: Token required.");

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const past = new Date(today); past.setDate(today.getDate() - 15);

        const toDate = tomorrow.toISOString().split('T')[0];
        const fromDate = past.toISOString().split('T')[0];

        // Fetching 5-Min Data
        const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/minutes/5/${toDate}/${fromDate}`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });

        const candles = response.data.data.candles.reverse(); 
        const closes = candles.map(c => c[4]);

        // Indicators
        const rsi7 = RSI.calculate({ period: 7, values: closes });
        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });

        const rOff = candles.length - rsi7.length;
        const e9Off = candles.length - ema9.length;
        const e21Off = candles.length - ema21.length;

        let trades = [];
        let inPosition = false;
        let entryPrice = 0;
        let netProfit = 0;
        let wins = 0;

        // Simulation Loop
        for (let i = 30; i < candles.length; i++) {
            const price = closes[i];
            const cRSI = rsi7[i - rOff];
            const cE9 = ema9[i - e9Off];
            const cE21 = ema21[i - e21Off];

            // Entry Logic (Long)
            if (!inPosition && cRSI < 25 && price > cE21 && price > cE9) {
                inPosition = true;
                entryPrice = price;
                trades.push({ type: 'BUY', price: entryPrice, time: candles[i][0] });
            } 
            // Exit Logic
            else if (inPosition) {
                const diff = price - entryPrice;
                // Exit on Target 300, Stop Loss 150, or Trend Reversal (Price < E9)
                if (diff >= 300 || diff <= -150 || price < cE9 || cRSI > 75) {
                    netProfit += diff;
                    if (diff > 0) wins++;
                    inPosition = false;
                    trades.push({ type: 'SELL', price: price, time: candles[i][0], pnl: diff });
                }
            }
        }

        const winRate = ((wins / (trades.length / 2)) * 100).toFixed(1);

        res.send(`
            <div style="font-family: sans-serif; padding: 30px; background: #f8fafc; min-height: 100vh;">
                <h2 style="color: #1e293b;">Performance Report (15 Days)</h2>
                <div style="display: flex; gap: 15px; margin-bottom: 25px;">
                    <div style="background: ${netProfit > 0 ? '#10b981' : '#ef4444'}; color: white; padding: 20px; border-radius: 8px; flex: 1;">
                        Total Profit: <b>₹${netProfit.toFixed(2)}</b>
                    </div>
                    <div style="background: #3b82f6; color: white; padding: 20px; border-radius: 8px; flex: 1;">
                        Total Trades: <b>${trades.length / 2}</b>
                    </div>
                    <div style="background: #6366f1; color: white; padding: 20px; border-radius: 8px; flex: 1;">
                        Win Rate: <b>${winRate}%</b>
                    </div>
                </div>
                <table border="1" style="width: 100%; border-collapse: collapse; background: white;">
                    <tr style="background: #f1f5f9;"><th>Type</th><th>Price</th><th>Time</th><th>Result</th></tr>
                    ${trades.map(t => `
                        <tr>
                            <td>${t.type}</td>
                            <td>${t.price}</td>
                            <td>${new Date(t.time).toLocaleString()}</td>
                            <td style="color: ${t.pnl > 0 ? 'green' : (t.pnl < 0 ? 'red' : 'black')}; font-weight: bold;">
                                ${t.pnl ? t.pnl.toFixed(2) : '-'}
                            </td>
                        </tr>`).join('')}
                </table>
                <br><a href="/" style="display: inline-block; padding: 10px 20px; background: #1e293b; color: white; text-decoration: none; border-radius: 5px;">Return to Tester</a>
            </div>
        `);
    } catch (e) {
        res.send(`<h3>Error Processing Data</h3><p>${e.message}</p>`);
    }
});

app.listen(3000);
