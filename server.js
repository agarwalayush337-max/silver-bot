const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- THE WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: auto; padding: 20px;">
            <h1 style="color: #2196F3;">🧪 Upstox API Laboratory</h1>
            <p>Paste your token and test different URL combinations from the documentation.</p>

            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #ddd;">
                <h3>1. Credentials</h3>
                <input type="text" id="token" placeholder="Paste Access Token here" style="width: 100%; padding: 12px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px;">
                
                <h3>2. The Test Link</h3>
                <p style="font-size: 12px; color: #666;">Example V3: <code>https://api.upstox.com/v3/historical-candle/MCX_FO%7C458305/30minute/2025-12-23/2025-12-01</code></p>
                <input type="text" id="apiUrl" placeholder="Paste Full API URL here" style="width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 4px;">
                
                <button onclick="fetchData()" style="width: 100%; margin-top: 20px; padding: 15px; background: #2196F3; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">FETCH DATA</button>
            </div>

            <div id="status" style="margin-top: 20px; font-weight: bold;"></div>

            <h3>3. Parsed Result (Latest Candle)</h3>
            <div id="parsed" style="background: #e3f2fd; padding: 15px; border-radius: 8px; font-family: monospace;">
                No data yet.
            </div>

            <h3>4. Full JSON Response</h3>
            <pre id="jsonOutput" style="background: #1e1e1e; color: #00ff00; padding: 20px; border-radius: 8px; overflow-x: auto; max-height: 400px; font-size: 12px;">
Waiting for input...
            </pre>
        </div>

        <script>
            async function fetchData() {
                const token = document.getElementById('token').value;
                const url = document.getElementById('apiUrl').value;
                const status = document.getElementById('status');
                const jsonOutput = document.getElementById('jsonOutput');
                const parsed = document.getElementById('parsed');

                if(!token || !url) {
                    alert("Please enter both Token and URL");
                    return;
                }

                status.innerHTML = "⏳ Fetching...";
                status.style.color = "orange";

                try {
                    const response = await fetch('/proxy-request', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token, url })
                    });

                    const result = await response.json();

                    if(result.error) {
                        status.innerHTML = "❌ Error";
                        status.style.color = "red";
                        jsonOutput.innerText = JSON.stringify(result, null, 2);
                        parsed.innerHTML = "Request failed.";
                    } else {
                        status.innerHTML = "✅ Success!";
                        status.style.color = "green";
                        jsonOutput.innerText = JSON.stringify(result.fullData, null, 2);
                        
                        // Parse latest candle
                        const candles = result.fullData.data.candles || result.fullData.data;
                        if(Array.isArray(candles) && candles.length > 0) {
                            const latest = candles[0];
                            parsed.innerHTML = "<b>Time:</b> " + latest[0] + "<br><b>Close Price:</b> <span style='font-size: 20px; color: blue;'>₹" + latest[4] + "</span>";
                        } else {
                            parsed.innerHTML = "Array found but it is empty.";
                        }
                    }
                } catch (e) {
                    status.innerHTML = "❌ System Error: " + e.message;
                }
            }
        </script>
    `);
});

// --- SERVER SIDE PROXY (To bypass CORS) ---
app.post('/proxy-request', async (req, res) => {
    const { token, url } = req.body;

    try {
        const upstoxRes = await axios.get(url, {
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        res.json({ fullData: upstoxRes.data });
    } catch (error) {
        res.json({ 
            error: true, 
            message: error.message, 
            details: error.response ? error.response.data : "No details" 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Laboratory live on port " + PORT));
