const express = require('express');
const axios = require('axios');
const { EMA, SMA, ATR } = require("technicalindicators");
const app = express();
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
let ACCESS_TOKEN = null;
const INSTRUMENT_KEY = "MCX_FO|458305"; 

// --- STRATEGY MEMORY ---
let isPositionOpen = false;
let entryPrice = 0;
let highestPriceSinceEntry = 0;

app.get('/', (req, res) => {
    const status = ACCESS_TOKEN ? "🟢 BOT ACTIVE" : "🔴 WAITING FOR TOKEN";
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 40px; background: #0a0a0a; color: #00ff00; min-height: 100vh;">
            <h1>🥈 Silver Prime v2025 Bot</h1>
            <p>Strategy: Breakout + Volume Spike + ATR Trailing</p>
            <div style="border: 2px solid #00ff00; padding: 20px; border-radius: 10px; display: inline-block;">
                <h3>Status: ${status}</h3>
                <p>Position: ${isPositionOpen ? 'LONG' : 'FLAT'}</p>
            </div>
            <br><br>
            <form action="/update-token" method="POST">
                <input type="text" name="token" placeholder="Paste Upstox Access Token" style="width: 350px; padding: 10px;">
                <button type="submit" style="padding: 10px 20px; cursor: pointer;">START TRADING</button>
            </form>
        </div>
    `);
});

app.post('/update-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

// --- TRADING ENGINE (5-Min Interval) ---
setInterval(async () => {
    if (!ACCESS_TOKEN) return;

    try {
        const encodedKey = encodeURIComponent(INSTRUMENT_KEY);
        // V3 Intraday URL
        const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/minutes/5`;
        
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });

        const candles = response.data.data.candles.reverse(); // Oldest to Newest
        const high = candles.map(c => c[2]);
        const low = candles.map(c => c[3]);
        const close = candles.map(c => c[4]);
        const volume = candles.map(c => c[5]);

        // --- CALCULATIONS ---
        const ema40 = EMA.calculate({ period: 40, values: close });
        const ema80 = EMA.calculate({ period: 80, values: close });
        const smaVol20 = SMA.calculate({ period: 20, values: volume });
        const atr = ATR.calculate({ high, low, close, period: 14 });

        const lastClose = close[close.length - 1];
        const lastHigh = high[high.length - 1];
        const lastVol = volume[volume.length - 1];
        
        const curE40 = ema40[ema40.length - 1];
        const curE80 = ema80[ema80.length - 1];
        const curSmaVol = smaVol20[smaVol20.length - 1];
        const curAtr = atr[atr.length - 1];

        // Get highest of last 10 (excluding current)
        const recentHighs = high.slice(-11, -1);
        const breakOutLevel = Math.max(...recentHighs);

        console.log(`🔎 Price: ${lastClose} | Breakout: ${breakOutLevel} | Vol: ${lastVol} vs ${curSmaVol * 1.5}`);

        // --- EXECUTION LOGIC ---

        // 1. ENTRY (Long Silver)
        if (!isPositionOpen) {
            const trendUp = curE40 > curE80;
            const volSpike = lastVol > (curSmaVol * 1.5);
            const priceBreak = lastClose > breakOutLevel;

            if (trendUp && volSpike && priceBreak) {
                console.log("🚀 LONG ENTRY @ " + lastClose);
                isPositionOpen = true;
                entryPrice = lastClose;
                highestPriceSinceEntry = lastHigh;
            }
        } 
        
        // 2. TRAILING EXIT
        else {
            if (lastHigh > highestPriceSinceEntry) highestPriceSinceEntry = lastHigh;
            
            // Exit if price drops below (Recent High - 3 * ATR)
            const stopLevel = highestPriceSinceEntry - (curAtr * 3.0);
            
            if (lastClose < stopLevel) {
                console.log(`💰 TRAILING EXIT @ ${lastClose} | Profit: ${lastClose - entryPrice}`);
                isPositionOpen = false;
                entryPrice = 0;
                highestPriceSinceEntry = 0;
            }
        }

    } catch (e) {
        console.error("Bot Error: " + e.message);
    }
}, 30000); // Check every 30 seconds

app.listen(3000, () => console.log("Prime v2025 Bot Running"));
