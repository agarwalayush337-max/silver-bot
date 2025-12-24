const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');
const { EMA, SMA, ATR } = require("technicalindicators");

// ✅ CORRECT IMPORT for Manual WebSocket
const UpstoxClient = require('upstox-js-sdk');
const protobuf = require("protobufjs"); // 🆕 REQUIRED

const app = express();
// --- 📜 UPSTOX PROTOBUF SCHEMA ---
// This definition translates the binary stream into readable numbers
// --- 📜 OFFICIAL UPSTOX PROTO SCHEMA ---
const PROTO_DEF = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;

message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
}

message MarketLevel {
  repeated Quote bidAskQuote = 1;
}

message MarketOHLC {
  repeated OHLC ohlc = 1;
}

message Quote {
  int64 bidQ = 1;
  double bidP = 2;
  int64 askQ = 3;
  double askP = 4;
}

message OptionGreeks {
  double delta = 1;
  double theta = 2;
  double gamma = 3;
  double vega = 4;
  double rho = 5;
}

message OHLC {
  string interval = 1;
  double open = 2;
  double high = 3;
  double low = 4;
  double close = 5;
  int64 vol = 6;
  int64 ts = 7;
}

enum Type {
  initial_feed = 0;
  live_feed = 1;
  market_info = 2;
}

message MarketFullFeed {
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq = 9;
  double tsq = 10;
}

message IndexFullFeed {
  LTPC ltpc = 1;
  MarketOHLC marketOHLC = 2;
}

message FullFeed {
  oneof FullFeedUnion {
    MarketFullFeed marketFF = 1;
    IndexFullFeed indexFF = 2;
  }
}

message FirstLevelWithGreeks {
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}

message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}

enum RequestMode {
  ltpc = 0;
  full_d5 = 1;
  option_greeks = 2;
  full_d30 = 3;
}

message MarketInfo {
  map<string, int32> segmentStatus = 1;
}

message FeedResponse {
  Type type = 1;
  map<string, Feed> feeds = 2; 
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`;

// Initialize the Translator
let FeedResponse;
try {
    const root = protobuf.parse(PROTO_DEF).root;
    FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
} catch (e) { console.error("❌ Proto Parse Error:", e); }

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;

// --- 🔒 ENVIRONMENT VARIABLES ---
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

// Redis with Retry Logic
const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379", { maxRetriesPerRequest: null });

// --- GLOBAL VARIABLES ---
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let sseClients = []; 
let currentWs = null; // ✅ Websocket Tracker
// 🆕 Added historicalPnL and exchangeSLPrice
let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    historicalPnL: 0,   // Tracks Closed PnL
    totalPnL: 0,        // (Unused now, replaced by historicalPnL)
    quantity: 0, 
    history: [], 
    slOrderId: null,
    exchangeSLPrice: 0  // Tracks the actual SL at Exchange
};

// 🆕 RESET PNL ROUTE
app.post('/reset-pnl', async (req, res) => {
    botState.historicalPnL = 0;
    botState.totalPnL = 0;
    await saveState();
    res.redirect('/');
});

// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) botState = JSON.parse(saved);
        console.log("📂 System State Loaded.");
    } catch (e) { console.log("Redis sync issue (first run?)"); }
}
loadState();

async function saveState() { await redis.set('silver_bot_state', JSON.stringify(botState)); }

// --- TIME HELPERS ---
function getIST() { return new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})); }
function formatDate(date) { return date.toISOString().split('T')[0]; }
function isApiAvailable() { const m = (getIST().getHours()*60)+getIST().getMinutes(); return m >= 330 && m < 1440; }
function isMarketOpen() { const t = getIST(); const m = (t.getHours()*60)+t.getMinutes(); return t.getDay()!==0 && t.getDay()!==6 && m >= 540 && m < 1430; }

// --- DASHBOARD HELPERS ---
function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    return (parseFloat(botState.totalPnL) + uPnL).toFixed(2);
}

function pushToDashboard() {
    const data = JSON.stringify({ 
        price: lastKnownLtp, 
        pnl: calculateLivePnL(), 
        stop: botState.currentStop,
        status: ACCESS_TOKEN ? "ONLINE" : "OFFLINE"
    });
    sseClients.forEach(c => { try { c.res.write(`data: ${data}\n\n`); } catch(e) {} });
}

// --- EXCHANGE SL MANAGEMENT ---
// --- MANAGE EXCHANGE SL (With Error Details) ---
async function manageExchangeSL(side, qty, triggerPrice) {
    if(!ACCESS_TOKEN) return;

    // Safety: Ensure trigger price is valid
    if (!triggerPrice || triggerPrice <= 0) {
        console.error("❌ SL Failed: Invalid Trigger Price (" + triggerPrice + ")");
        return;
    }

    try {
        // If an old SL exists, try to cancel it first (don't worry if it fails)
        if (botState.slOrderId) {
            try {
                await axios.delete(`https://api.upstox.com/v2/order/cancel?order_id=${botState.slOrderId}`, { 
                    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
                });
            } catch (ignore) {}
        }
        
        console.log(`📝 Placing SL-M | Qty: ${qty} | Trigger: ${triggerPrice}`);

        const res = await axios.post("https://api.upstox.com/v2/order/place", {
            quantity: qty, 
            product: "I", 
            validity: "DAY", 
            price: 0, 
            instrument_token: INSTRUMENT_KEY, 
            order_type: "SL-M", 
            transaction_type: side === "BUY" ? "SELL" : "BUY", 
            trigger_price: Math.round(triggerPrice), 
            is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});
        
        botState.slOrderId = res.data.data.order_id;
        botState.exchangeSLPrice = triggerPrice; // 🆕 Save the SL Price
        await saveState();
    } catch (e) { console.error(`❌ Exchange SL Failed`); }
}

async function modifyExchangeSL(newTrigger) {
    if (!botState.slOrderId) return;
    try {
        await axios.put("https://api.upstox.com/v2/order/modify", {
            order_id: botState.slOrderId,
            trigger_price: Math.round(newTrigger),
            quantity: botState.quantity,
            order_type: "SL-M"
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
    } catch (e) { /* Likely filled */ }
}

// --- 🔌 WEBSOCKET (Universal Decoder) ---
// --- 🔌 WEBSOCKET (Binary Request & Response) ---
async function initWebSocket() {
    if (!ACCESS_TOKEN || currentWs) return;
    try {
        console.log("🔌 Initializing WS (V3 Binary Mode)...");
        const response = await axios.get("https://api.upstox.com/v3/feed/market-data-feed/authorize", {
            headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN, 'Accept': 'application/json' }
        });
        const wsUrl = response.data.data.authorizedRedirectUri;
        const WebSocket = require('ws'); 
        currentWs = new WebSocket(wsUrl, { followRedirects: true });
        
        currentWs.binaryType = "arraybuffer"; 

        currentWs.onopen = () => {
            console.log("✅ WebSocket Connected! Subscribing...");
            const subRequest = {
                guid: "bot-" + Date.now(),
                method: "sub",
                data: { mode: "ltpc", instrumentKeys: [INSTRUMENT_KEY] }
            };
            
            // 🚨 CRITICAL FIX: Send as Binary Buffer, not Text
            // Upstox V3 ignores text frames for subscriptions
            const binaryMsg = Buffer.from(JSON.stringify(subRequest));
            currentWs.send(binaryMsg);
        };

        currentWs.onmessage = (msg) => {
            try {
                if (!FeedResponse) return;

                // 1. Decode Response
                const buffer = new Uint8Array(msg.data);
                const message = FeedResponse.decode(buffer);
                const object = FeedResponse.toObject(message, { 
                    longs: String, 
                    enums: String, 
                    bytes: String, 
                    defaults: true, 
                    oneofs: true 
                });

                // 2. Universal Price Search
                if (object && object.feeds) {
                    for (const key in object.feeds) {
                        const feed = object.feeds[key];
                        let newPrice = 0;

                        // Check all possible locations for price
                        if (feed.ltpc?.ltp) newPrice = feed.ltpc.ltp;
                        else if (feed.fullFeed?.marketFF?.ltpc?.ltp) newPrice = feed.fullFeed.marketFF.ltpc.ltp;
                        else if (feed.fullFeed?.indexFF?.ltpc?.ltp) newPrice = feed.fullFeed.indexFF.ltpc.ltp;

                        // Update Dashboard
                        if (newPrice > 0) {
                             // Strict check or fallback if we only have 1 key
                            if (key.includes("458305") || Object.keys(object.feeds).length === 1) {
                                if (newPrice !== lastKnownLtp) {
                                    lastKnownLtp = newPrice;
                                    pushToDashboard(); 
                                }
                            }
                        }
                    }
                }
            } catch (e) { 
                console.error("❌ Decode Logic Error:", e.message);
            }
        };

        currentWs.onclose = () => { currentWs = null; };
        currentWs.onerror = (err) => { console.error("❌ WS Error:", err.message); currentWs = null; };
    } catch (e) { currentWs = null; }
}

// --- 🤖 AUTO-LOGIN SYSTEM ---
async function performAutoLogin() {
    console.log("🤖 STARTING AUTO-LOGIN SEQUENCE...");
    
    if (currentWs) { try { currentWs.close(); } catch(e) {} currentWs = null; }

    let browser = null;
    try {
        const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(UPSTOX_TOTP_SECRET) });
        const codeOTP = totp.generate();
        console.log("🔐 Generated TOTP.");

        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${API_KEY}&redirect_uri=${REDIRECT_URI}`;
        console.log("🌍 Navigating to Upstox...");
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const mobileInput = await page.$('#mobileNum');
        if (!mobileInput) throw new Error("Login Page Not Loaded");

        console.log("📱 Detected Login Screen. Typing Credentials...");
        await page.type('#mobileNum', UPSTOX_USER_ID);
        await page.click('#getOtp');
        
        await page.waitForSelector('#otpNum', { visible: true, timeout: 30000 });
        await page.type('#otpNum', codeOTP);
        await page.click('#continueBtn');

        await page.waitForSelector('#pinCode', { visible: true, timeout: 30000 });
        await page.type('#pinCode', UPSTOX_PIN);
        await page.click('#pinContinueBtn');

        // ✅ FIXED: Wait for URL instead of network idle
        await page.waitForFunction(() => window.location.href.includes('code='), { timeout: 40000 });
        
        const finalUrl = page.url();
        const authCode = new URL(finalUrl).searchParams.get('code');

        const params = new URLSearchParams();
        params.append('code', authCode);
        params.append('client_id', API_KEY);
        params.append('client_secret', API_SECRET);
        params.append('redirect_uri', REDIRECT_URI);
        params.append('grant_type', 'authorization_code');

        const res = await axios.post('https://api.upstox.com/v2/login/authorization/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
        ACCESS_TOKEN = res.data.access_token;
        
        await initWebSocket();
        
        console.log("🎉 SUCCESS! Session Active & Socket Started.");
        if (browser) await browser.close(); 
        browser = null;

        botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SYSTEM", price: 0, id: "Auto-Login OK", status: "OK" });
        await saveState();

    } catch (e) { 
        console.error("❌ Auto-Login Failed:", e.message); 
        if (browser) await browser.close();
    } 
}

// --- DATA ENGINE ---
async function getMergedCandles() {
    const today = new Date();
    const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
    const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5`;
    const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

    try {
        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } }))
        ]);
        const mergedMap = new Map();
        (histRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        (intraRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        return Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));
    } catch (e) { return []; }
}

// --- ✅ RESTORED: ORDER VERIFICATION LOGIC ---
async function fetchLatestOrderId() {
    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        if (res.data?.data?.length > 0) return res.data.data.sort((a, b) => new Date(b.order_timestamp) - new Date(a.order_timestamp))[0].order_id;
    } catch (e) { console.log("ID Fetch Failed: " + e.message); } return null;
}

// --- VERIFY ORDER (Updates Dashboard Logs) ---
async function verifyOrderStatus(orderId, context) {
    if (!orderId) orderId = await fetchLatestOrderId();
    if (!orderId) return;
    
    // Wait a moment for the exchange to process the fill
    if (context !== 'MANUAL_SYNC' && context !== 'EXIT_CHECK') await new Promise(r => setTimeout(r, 2000)); 

    try {
        const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        const order = res.data.data.find(o => o.order_id === orderId);
        if (!order) return;

        console.log(`🔎 Verifying Order ${orderId}: ${order.status}`);
        
        if (order.status === 'complete') {
            const realPrice = parseFloat(order.average_price);
            
            // 1. Update State (PnL / Position)
            // ... inside verifyOrderStatus ...
            if (context === 'EXIT_CHECK') {
                console.log("✅ Exchange SL Filled! Clearing Position.");
                // 🆕 Calculate PnL for this specific trade
                let tradePnL = 0;
                if (botState.positionType === 'LONG') tradePnL = (realPrice - botState.entryPrice) * botState.quantity;
                if (botState.positionType === 'SHORT') tradePnL = (botState.entryPrice - realPrice) * botState.quantity;
                
                // 🆕 Add to Historical PnL
                botState.historicalPnL += tradePnL;

                botState.positionType = null; 
                botState.slOrderId = null; 
                botState.currentStop = null;
                botState.exchangeSLPrice = 0; // Clear Exchange SL
// ...
                
                // Add SL Exit Log if missing
                const exists = botState.history.find(h => h.id === orderId);
                if (!exists) {
                     botState.history.unshift({ time: getIST().toLocaleTimeString(), type: "SL-EXIT", price: realPrice, id: orderId, status: "FILLED" });
                }
            } 
            else if (botState.positionType) {
                botState.entryPrice = realPrice;
            }

            // 2. FIX DASHBOARD LOGS
            // Find the log that says "SENT" or has this ID, and update it with REAL data
            const logIndex = botState.history.findIndex(h => h.id === orderId || (h.status === 'SENT' && h.type === order.transaction_type));
            
            if (logIndex !== -1) {
                botState.history[logIndex].price = realPrice; // Set Actual Execution Price
                botState.history[logIndex].status = "FILLED";
                botState.history[logIndex].id = orderId;      // Ensure ID is saved
            }

            await saveState();
            pushToDashboard(); // 🚀 Force UI Update
            
        } else if (['rejected', 'cancelled'].includes(order.status)) {
            if (context === 'EXIT_CHECK') botState.slOrderId = null;
            else if (context !== 'MANUAL_SYNC' && botState.positionType) {
                botState.positionType = null; botState.entryPrice = 0; botState.quantity = 0;
            }
            
            // Mark log as failed
            const log = botState.history.find(h => h.id === orderId);
            if (log) log.status = order.status.toUpperCase();
            
            await saveState();
            pushToDashboard();
        }
    } catch (e) { console.log("Verification Error: " + e.message); }
}
// --- PLACE ORDER (Robust Logging) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    const isAmo = !isMarketOpen();
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997)); 

    try {
        console.log(`🚀 Sending ${type}: ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, is_amo: isAmo
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = res.data?.data?.order_id;
        
        // Log to History immediately
        botState.history.unshift({ 
            time: getIST().toLocaleTimeString(), 
            type, 
            price: limitPrice, 
            id: orderId || "PENDING", // If ID is missing, mark as PENDING
            status: "SENT" 
        });
        
        const slPrice = type === "BUY" ? (ltp - 800) : (ltp + 800);
        await manageExchangeSL(type, qty, slPrice);

        await saveState();
        pushToDashboard(); // Update UI to show "SENT" immediately

        if (orderId) verifyOrderStatus(orderId, 'ENTRY');
        return true;
    } catch (e) {
        console.error(`❌ ORDER FAILED: ${e.message}`);
        return false;
    }
}

// --- CRON & WATCHDOG ---
setInterval(() => {
    const now = getIST();
    if (now.getHours() === 8 && now.getMinutes() === 30 && !ACCESS_TOKEN) performAutoLogin();
}, 60000);

// TRADING LOOP (Runs every 30s)
// --- TRADING ENGINE (Prevents Double Orders) ---
// --- TRADING ENGINE (Strict WebSocket Only) ---
setInterval(async () => {
    if (!ACCESS_TOKEN || !isApiAvailable()) { if (!ACCESS_TOKEN) console.log("📡 Waiting for Token..."); return; }
    
    // 1. WebSocket Watchdog
    if ((lastKnownLtp === 0 || !currentWs) && ACCESS_TOKEN) {
        initWebSocket();
        // Wait for next loop; do not trade on 0 price
        console.log("⏳ Waiting for WebSocket Price..."); 
        return; 
    }

    try {
        const candles = await getMergedCandles();
        console.log(`--------------------------------------------------`);
        console.log(`🕒 ${getIST().toLocaleTimeString()} | LTP: ₹${lastKnownLtp} | WS: ${currentWs?'Live':'Off'}`);

        if (candles.length > 200) {
            const cl = candles.map(c => c[4]), h = candles.map(c => c[2]), l = candles.map(c => c[3]), v = candles.map(c => c[5]);

            const e50 = EMA.calculate({period: 50, values: cl}), e200 = EMA.calculate({period: 200, values: cl}), vAvg = SMA.calculate({period: 20, values: v}), atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
            const curE50=e50[e50.length-1], curE200=e200[e200.length-1], curV=v[v.length-1], curAvgV=vAvg[vAvg.length-1], curA=atr[atr.length-1];
            const bH = Math.max(...h.slice(-11, -1)), bL = Math.min(...l.slice(-11, -1));

            console.log(`📈 E50: ${curE50.toFixed(0)} | E200: ${curE200.toFixed(0)} | Vol: ${curV}`);

            if (isMarketOpen()) {
                if (!botState.positionType) {
                    // --- ENTRY LOGIC ---
                    if (cl[cl.length-2] > e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp > bH) {
                        botState.positionType = 'LONG'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp - (curA * 3);
                        await saveState(); await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                    } 
                    else if (cl[cl.length-2] < e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp < bL) {
                        botState.positionType = 'SHORT'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; botState.currentStop = lastKnownLtp + (curA * 3);
                        await saveState(); await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    }
                } else {
                    // --- EXIT / TRAILING LOGIC ---
                    if (botState.positionType === 'LONG') {
                        let ns = Math.max(lastKnownLtp - (curA * 3), botState.currentStop);
                        if (ns > botState.currentStop) { botState.currentStop = ns; await modifyExchangeSL(ns); }
                        
                        // EXIT TRIGGER
                        if (lastKnownLtp < botState.currentStop) {
                            if (botState.slOrderId) {
                                console.log("🛑 Stop Hit! Waiting for Exchange SL...");
                                verifyOrderStatus(botState.slOrderId, 'EXIT_CHECK');
                            } else {
                                console.log("🛑 Stop Hit! Emergency Exit.");
                                await placeOrder("SELL", botState.quantity, lastKnownLtp);
                            }
                        }
                    } else {
                        let ns = Math.min(lastKnownLtp + (curA * 3), botState.currentStop);
                        if (ns < botState.currentStop) { botState.currentStop = ns; await modifyExchangeSL(ns); }
                        
                        // EXIT TRIGGER
                        if (lastKnownLtp > botState.currentStop) {
                            if (botState.slOrderId) {
                                console.log("🛑 Stop Hit! Waiting for Exchange SL...");
                                verifyOrderStatus(botState.slOrderId, 'EXIT_CHECK');
                            } else {
                                console.log("🛑 Stop Hit! Emergency Exit.");
                                await placeOrder("BUY", botState.quantity, lastKnownLtp);
                            }
                        }
                    }
                }
            }
        }
    } catch (e) { 
        if(e.response?.status===401) { ACCESS_TOKEN = null; performAutoLogin(); } 
    }
}, 30000);

// --- 📡 API & DASHBOARD ---
app.get('/live-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const id = Date.now();
    sseClients.push({ id, res });
    req.on('close', () => sseClients = sseClients.filter(c => c.id !== id));
});

app.get('/', (req, res) => {
    // 1. Calculate Open PnL (Unrealized)
    let openPnL = 0;
    if (botState.positionType === 'LONG') openPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') openPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    const totalNetPnL = (botState.historicalPnL + openPnL).toFixed(2);

    // 2. Generate Trade Log (New Format: Time | Details | Actual | ID)
    const historyHTML = botState.history.slice(0, 15).map(t => {
        let color = '#fbbf24'; // Default Yellow
        if(t.type === 'BUY' || t.status === 'FILLED') color = '#4ade80'; // Green
        if(t.type === 'SELL' || t.type === 'SL-EXIT') color = '#f87171'; // Red
        if(t.type === 'SYSTEM') color = '#94a3b8'; // Grey

        return `
        <tr style="border-bottom:1px solid #334155; font-size:12px;">
            <td style="padding:8px; color:#94a3b8;">${t.time}</td>
            <td style="padding:8px; font-weight:bold; color:${color};">
                ${t.type === 'SYSTEM' ? 'Autologin' : t.type} <span style="font-weight:normal; color:#fff;">(${t.status})</span>
            </td>
            <td style="padding:8px;">₹${t.price}</td>
            <td style="padding:8px; color:#64748b; font-size:10px;">${t.id || '-'}</td>
        </tr>`;
    }).join('');

    const simControls = SIMULATION_MODE ? `
    <div style="background:#334155; padding:10px; margin-bottom:15px; border-radius:8px; text-align:center;">
        <h4 style="margin:0 0 10px 0; color:#fbbf24;">🎮 God Mode Controls</h4>
        <div style="display:flex; gap:5px; justify-content:center; flex-wrap:wrap;">
            <button onclick="fetch('/sim/pump', {method:'POST'})" style="padding:8px; background:#4ade80; border:none; border-radius:4px; cursor:pointer; color:black; font-weight:bold;">🚀 PUMP</button>
            <button onclick="fetch('/sim/dump', {method:'POST'})" style="padding:8px; background:#f87171; border:none; border-radius:4px; cursor:pointer; color:black; font-weight:bold;">📉 DUMP</button>
            <button onclick="fetch('/sim/spike-vol', {method:'POST'})" style="padding:8px; background:#cbd5e1; border:none; border-radius:4px; cursor:pointer; color:black; font-weight:bold;">🔊 VOL</button>
        </div>
        <div style="margin-top:5px; display:flex; gap:5px; justify-content:center;">
            <button onclick="fetch('/sim/trend-up', {method:'POST'})" style="padding:5px; font-size:10px; cursor:pointer;">Trend UP ⬆️</button>
            <button onclick="fetch('/sim/freeze', {method:'POST'})" style="padding:5px; font-size:10px; cursor:pointer; background:#fbbf24; color:black;">PAUSE ⏸️</button>
            <button onclick="fetch('/sim/trend-down', {method:'POST'})" style="padding:5px; font-size:10px; cursor:pointer;">Trend DOWN ⬇️</button>
        </div>
    </div>` : '';

    res.send(`<!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Silver Prime Auto</title><script>const source = new EventSource('/live-updates');source.onmessage = (e) => {const d = JSON.parse(e.data);document.getElementById('live-price').innerText = '₹' + d.price;const stat = document.getElementById('live-status');stat.innerText = d.status;stat.style.color = d.status === 'ONLINE' ? '#4ade80' : '#ef4444';};</script></head><body style="display:flex; justify-content:center; padding:20px;"><div style="width:100%; max-width:500px; background:#1e293b; padding:25px; border-radius:15px;"><h2 style="color:#38bdf8; text-align:center;">🥈 Silver Prime Auto</h2><div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:15px;"><small style="color:#94a3b8;">LIVE PRICE</small><br><b id="live-price" style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp || '---'}</b></div>
    
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
            <small style="color:#94a3b8;">HISTORICAL PNL</small><br><b style="color:${botState.historicalPnL >= 0 ? '#4ade80' : '#f87171'}">₹${botState.historicalPnL.toFixed(2)}</b>
        </div>
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
            <small style="color:#94a3b8;">TOTAL NET PNL</small><br><b style="color:${totalNetPnL >= 0 ? '#4ade80' : '#f87171'}">₹${totalNetPnL}</b>
        </div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
            <small style="color:#94a3b8;">STRATEGY SL</small><br><b style="color:#f472b6;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '-'}</b>
        </div>
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px; border:1px solid #334155;">
            <small style="color:#94a3b8;">EXCHANGE SL ORDER</small><br>
            <b style="color:#fbbf24;">₹${botState.exchangeSLPrice || '-'}</b>
            <div style="font-size:9px; color:#64748b; margin-top:2px;">${botState.slOrderId || 'NO ORDER'}</div>
        </div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">POSITION</small><br><b style="color:#facc15;">${botState.positionType || 'NONE'}</b></div>
        <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">STATUS</small><br><b id="live-status" style="color:${ACCESS_TOKEN?'#4ade80':'#ef4444'}">${ACCESS_TOKEN?'ONLINE':'OFFLINE'}</b></div>
    </div>

    <div style="display:flex; gap:10px; margin-bottom:10px;">
            <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#6366f1; color:white; border:none; border-radius:8px; cursor:pointer;">🤖 AUTO-LOGIN</button></form>
            <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:10px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px; cursor:pointer;">🔄 SYNC PRICE</button></form>
    </div>
    
    <form action="/reset-pnl" method="POST" style="margin-bottom:20px;">
        <button style="width:100%; padding:5px; background:#334155; color:#94a3b8; border:1px solid #475569; border-radius:6px; cursor:pointer; font-size:10px;">⚠️ RESET PNL HISTORY</button>
    </form>

    ${simControls}

    <h4 style="color:#94a3b8; border-bottom:1px solid #334155;">Trade Log</h4>
    <table style="width:100%; border-collapse:collapse; text-align:left;">
        <thead style="color:#64748b; font-size:10px; text-transform:uppercase;">
            <tr><th style="padding:8px;">Time</th><th style="padding:8px;">Details</th><th style="padding:8px;">Actual</th><th style="padding:8px;">Order ID</th></tr>
        </thead>
        <tbody>${historyHTML}</tbody>
    </table>
    </div></body></html>`);
});

app.post('/trigger-login', (req, res) => { performAutoLogin(); res.redirect('/'); });

// ✅ RESTORED: SYNC PRICE ROUTE
// ✅ FIXED: SYNC PRICE ROUTE
// --- SYNC PRICE ROUTE (With Live Price Fetch) ---
// --- SYNC PRICE ROUTE (Fixed for Manual Orders) ---
app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        console.log("🔄 Syncing Position...");
        
        const response = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        
        // ✅ FIX: Search for the ID "458305" anywhere in the instrument token
        const pos = (response.data?.data || []).find(p => p.instrument_token && p.instrument_token.includes("458305"));
        
        if (pos && parseInt(pos.quantity) !== 0) {
            const qty = parseInt(pos.quantity);
            botState.positionType = qty > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(qty);
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);
            botState.totalPnL = 0;
            
            // Force Price Check to avoid 0-price bug
            let currentLtp = lastKnownLtp;
            if (!currentLtp || currentLtp === 0) {
                try {
                    const qRes = await axios.get(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(INSTRUMENT_KEY)}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
                    currentLtp = qRes.data.data[INSTRUMENT_KEY].last_price;
                    lastKnownLtp = currentLtp; 
                } catch (e) { currentLtp = botState.entryPrice; }
            }

            // Calc SL
            const entrySide = qty > 0 ? 'BUY' : 'SELL';
            const slPrice = botState.positionType === 'LONG' ? (currentLtp - 800) : (currentLtp + 800);
            
            console.log(`🔄 Sync Found: ${botState.positionType} | SL: ${slPrice}`);
            await manageExchangeSL(entrySide, botState.quantity, slPrice);

        } else { 
            botState.positionType = null; 
            console.log("🔄 No open position found for ID 458305.");
        }
        await saveState();
    } catch (e) { console.error("Sync Error:", e.message); }
    res.redirect('/');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
