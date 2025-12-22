const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

let ACCESS_TOKEN = null;
const KEY = "MCX_FO|458305"; 

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: monospace; text-align: center; padding: 20px;">
            <h1>🧪 API Link Tester</h1>
            <p><strong>Target:</strong> ${KEY}</p>
            
            <form action="/set-token" method="POST" style="background: #eee; padding: 20px;">
                <input type="text" name="token" placeholder="Paste Token" style="width: 300px;">
                <button type="submit">Set Token</button>
            </form>

            <br><hr><br>

            <button onclick="testLink('tomorrow')">Test V3 (Tomorrow Date)</button>
            
            <button onclick="testLink('intraday')">Test Intraday (Control)</button>

            <div id="result" style="margin-top: 20px; text-align: left; background: #222; color: #0f0; padding: 20px; white-space: pre;">Waiting for test...</div>

            <script>
                async function testLink(type) {
                    document.getElementById('result').innerText = "Testing " + type + "...";
                    const res = await fetch('/test/' + type);
                    const data = await res.text();
                    document.getElementById('result').innerText = data;
                }
            </script>
        </div>
    `);
});

app.post('/set-token', (req, res) => {
    ACCESS_TOKEN = req.body.token;
    res.redirect('/');
});

app.get('/test/:type', async (req, res) => {
    if (!ACCESS_TOKEN) return res.send("❌ NO TOKEN");

    try {
        let url = "";
        const encodedKey = encodeURIComponent(KEY);
        
        // --- DYNAMIC DATE GENERATION ---
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1); // 🔥 THE FIX: Set date to tomorrow
        const past = new Date(today);
        past.setDate(today.getDate() - 10);

        const toDate = tomorrow.toISOString().split('T')[0]; // Format: YYYY-MM-DD
        const fromDate = past.toISOString().split('T')[0];

        if (req.params.type === 'tomorrow') {
            // V3 Historical with "Tomorrow" as End Date
            url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/30minute/${toDate}/${fromDate}`;
        } else {
            // Intraday (The one we know works, for comparison)
            url = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/30minute`;
        }

        const response = await axios.get(url, {
            headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });

        // Parse Data
        let candles = [];
        if (response.data?.data?.candles) candles = response.data.data.candles;
        else if (Array.isArray(response.data?.data)) candles = response.data.data;

        if (candles.length === 0) return res.send(`❌ URL: ${url}\n\nResult: NO CANDLES FOUND`);

        // Get Latest Candle
        const latest = candles[0]; // Upstox usually sends newest first? Or last?
        // Let's print the first and last to be sure
        const first = candles[0];
        const last = candles[candles.length - 1];

        res.send(`
🔗 URL TESTED: 
${url}

📊 DATA RECEIVED (${candles.length} candles):

---- CANDLE A (Index 0) ----
Time: ${first[0]}
Close: ${first[4]}

---- CANDLE B (Index Last) ----
Time: ${last[0]}
Close: ${last[4]}

✅ CHECK: One of these should be ~214,000.
        `);

    } catch (e) {
        res.send(`❌ ERROR: ${e.message}\n${JSON.stringify(e.response?.data)}`);
    }
});

app.listen(3000, () => console.log("Tester Ready"));
