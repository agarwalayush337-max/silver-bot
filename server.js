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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- 🔒 PASSWORD LOCK SCREEN ---
function authMiddleware(req, res, next) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return next(); // No password set? Let everyone in.

    // 1. Check if the user has the correct "cookie"
    const cookieString = req.headers.cookie || "";
    if (cookieString.includes(`auth=${password}`)) {
        return next(); // Password matches!
    }

    // 2. If not authenticated, show the Lock Screen
    // If this is a POST to /login, let it through so they can actually log in
    if (req.path === '/login' && req.method === 'POST') return next();

    // 3. Render the Lock Screen HTML
    res.send(`
        <!DOCTYPE html>
        <html style="background:#0f172a; color:white; font-family:sans-serif; height:100%;">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="display:flex; justify-content:center; align-items:center; height:100%; margin:0;">
            <form action="/login" method="POST" style="background:#1e293b; padding:40px; border-radius:15px; text-align:center; box-shadow:0 10px 25px rgba(0,0,0,0.5);">
                <h2 style="margin-top:0; color:#38bdf8;">🛡️ Restricted Access</h2>
                <p style="color:#94a3b8; margin-bottom:20px;">Enter Admin Password</p>
                <input type="password" name="password" placeholder="Password" autofocus 
                    style="width:100%; padding:12px; border-radius:8px; border:1px solid #334155; background:#0f172a; color:white; margin-bottom:15px; outline:none;">
                <button type="submit" style="width:100%; padding:12px; background:#6366f1; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;">Unlock Dashboard 🔓</button>
            </form>
        </body>
        </html>
    `);
}

// Apply the lock
app.use(authMiddleware);

// --- 🔑 LOGIN ROUTE ---
app.post('/login', (req, res) => {
    const password = process.env.ADMIN_PASSWORD;
    const userPassword = req.body.password;

    if (userPassword === password) {
        // Set a cookie manually (works without extra libraries)
        res.setHeader('Set-Cookie', `auth=${password}; HttpOnly; Max-Age=2592000; Path=/`); // Logged in for 30 days
        res.redirect('/');
    } else {
        res.send(`<h1 style="color:red; text-align:center; margin-top:50px;">❌ WRONG PASSWORD <br> <a href="/">Try Again</a></h1>`);
    }
});


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


// --- ⚙️ CONFIGURATION ---
const INSTRUMENT_KEY = "MCX_FO|458305"; 
const MAX_QUANTITY = 1;

// --- 🔒 ENVIRONMENT VARIABLES ---
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;

// Redis with Retry Logic
const redis = new Redis(REDIS_URL || "redis://red-d54pc4emcj7s73evgtbg:6379", { maxRetriesPerRequest: null });

// --- GLOBAL VARIABLES ---
// --- GLOBAL VARIABLES ---
let ACCESS_TOKEN = null;
let lastKnownLtp = 0; 
let sseClients = []; 
let currentWs = null; 
// ✅ NEW: Store ATR here so WebSocket can read it instantly
let globalATR = 800; 
// ✅ NEW: For Rate Limiting (Throttle)
let lastSlUpdateTime = 0; 

let botState = { 
    positionType: null, entryPrice: 0, currentStop: null, totalPnL: 0, quantity: 0, 
    history: [], slOrderId: null, isTradingEnabled: true, hiddenLogIds: [],
    
    // ✅ NEW: Tracks the highest profit seen during the CURRENT active trade
    maxRunUp: 0, 

    // ✅ NEW: Stores temporary data for trades currently being monitored (for 10 mins)
    activeMonitors: {} 
};


// ✅ HELPER: Pair Detection (Finds matching Buy+Sell to highlight them)
function getPairedLogs(logs) {
    const pairedIds = new Set();
    // Sort by time ascending to match pairs chronologically
    const sorted = [...logs].sort((a,b) => new Date(a.time) - new Date(b.time)); 
    
    let openTrade = null;
    sorted.forEach(log => {
        if (log.status !== 'FILLED') return;
        
        if (!openTrade) {
            openTrade = log;
        } else {
            // Check if opposite types (Buy vs Sell)
            if ((openTrade.type === 'BUY' && log.type === 'SELL') || (openTrade.type === 'SELL' && log.type === 'BUY')) {
                pairedIds.add(openTrade.id);
                pairedIds.add(log.id);
                openTrade = null; // Reset pair bucket
            }
        }
    });
    return pairedIds;
}

// ✅ HELPER: Generate Consistent Log HTML (Grid Layout Fix)
function generateLogHTML(logs) {
    const pairedIds = getPairedLogs(logs);

    return logs.map(t => {
        const isManual = t.tag !== 'API_BOT' && t.status === 'FILLED';
        const deleteBtn = isManual ? `<a href="/delete-log/${t.id}" style="color:#ef4444; font-size:10px; margin-left:5px; text-decoration:none;">[❌]</a>` : '';
        const analyzeBtn = (t.pnl < 0 && t.status === 'FILLED') ? `<br><a href="/analyze-sl/${t.id}" target="_blank" style="color:#f472b6; font-size:10px; text-decoration:none;">🔍</a>` : '';
        
        // Highlight Logic: Dark gradient for paired trades
        const isPaired = pairedIds.has(t.id);
        const bgStyle = isPaired ? 'background:linear-gradient(90deg, #1e293b 0%, #334155 100%); border-left: 3px solid #6366f1;' : 'border-bottom:1px solid #334155;';

        // CSS GRID: 1.2fr 0.8fr 1fr 1fr 1fr 1.5fr (Strict Column Widths)
        return `<div style="display:grid; grid-template-columns: 1.2fr 0.8fr 1fr 1fr 1fr 1.5fr; gap:5px; padding:10px; font-size:11px; align-items:center; ${bgStyle} margin-bottom:2px; border-radius:4px;">
            <span style="color:#94a3b8;">${t.time}</span> 
            <b style="text-align:center; color:${t.type=='BUY'?'#4ade80':t.type=='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span style="text-align:right; color:#cbd5e1;">₹${t.orderedPrice || '-'}</span> 
            <span style="text-align:right; font-weight:bold; color:white;">₹${t.executedPrice || '-'}</span> 
            <span style="text-align:right; font-weight:bold; color:${(t.pnl || 0) >= 0 ? '#4ade80' : '#f87171'};">${t.pnl ? '₹'+t.pnl.toFixed(0) : ''} ${analyzeBtn} ${deleteBtn}</span>
            <span style="text-align:right; color:#64748b; font-family:monospace; overflow:hidden; text-overflow:ellipsis;">${t.id || '-'}</span>
        </div>`;
    }).join('');
}
// --- STATE MANAGEMENT ---
// --- STATE MANAGEMENT ---
async function loadState() {
    try {
        const saved = await redis.get('silver_bot_state');
        if (saved) {
            const loadedData = JSON.parse(saved);
            botState = loadedData;
            
            // ✅ FIX: Ensure new fields exist even if loading old data
            if (!botState.activeMonitors) botState.activeMonitors = {}; 
            if (!botState.hiddenLogIds) botState.hiddenLogIds = [];
            if (typeof botState.maxRunUp === 'undefined') botState.maxRunUp = 0;
            
            console.log("📂 System State Loaded & Patched.");
        } else {
            console.log("📂 No saved state found. Starting fresh.");
        }
    } catch (e) { console.log("Redis sync issue (first run?):", e.message); }
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

// --- DASHBOARD HELPERS ---
function calculateLivePnL() {
    let uPnL = 0;
    if (botState.positionType === 'LONG') uPnL = (lastKnownLtp - botState.entryPrice) * botState.quantity;
    if (botState.positionType === 'SHORT') uPnL = (botState.entryPrice - lastKnownLtp) * botState.quantity;
    
    // ✅ NEW: Calculate Historical PnL by summing logs
    const historyPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);
    
    return { live: uPnL.toFixed(2), history: historyPnL.toFixed(2) };
}

// ✅ UPDATED DASHBOARD PUSHER (Sends Logs too)
// ✅ UPDATED DASHBOARD PUSHER (Now sends Position Status)
function pushToDashboard() {
    const hasPosition = botState.positionType && botState.positionType !== 'NONE';
    const pnlData = calculateLivePnL();
    
    const todayStr = formatDate(getIST());
    const todayLogs = botState.history.filter(t => t.date === todayStr && !t.type.includes('SYSTEM') && t.status !== 'CANCELLED');
    const displayLogs = generateLogHTML(todayLogs);

    const data = JSON.stringify({ 
        price: lastKnownLtp, 
        pnl: pnlData.live,
        historicalPnl: pnlData.history,
        stop: hasPosition ? botState.currentStop : 0,
        slID: hasPosition ? botState.slOrderId : null,
        status: ACCESS_TOKEN ? "ONLINE" : "OFFLINE",
        isTrading: botState.isTradingEnabled,
        position: botState.positionType || 'NONE', // ✅ FIXED: Now sending Position Type
        logsHTML: displayLogs 
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
        console.log("✅ SL Placed Order ID:", botState.slOrderId);
        await saveState();

    } catch (e) { 
        // 🚨 PRINT THE REAL ERROR
        const errMsg = e.response?.data?.errors?.[0]?.message || e.message;
        console.error(`❌ Exchange SL Placement Failed: ${errMsg}`); 
    }
}

async function modifyExchangeSL(newTrigger) {
    if (!botState.slOrderId) return;
    try {
        await axios.put("https://api.upstox.com/v2/order/modify", {
            order_id: botState.slOrderId,
            order_type: "SL-M",
            quantity: botState.quantity,
            trigger_price: Math.round(newTrigger),
            price: 0,           // ✅ FIXED: Added required field
            validity: "DAY",    // ✅ FIXED: Added required field
            disclosed_quantity: 0
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
    } catch (e) { 
        const errMsg = e.response?.data?.errors?.[0]?.message || e.message;
        console.log(`❌ SL Modify Failed: ${errMsg}`);
    }
}
// --- 🔌 WEBSOCKET (High-Precision Recorder) ---
async function initWebSocket() {
    if (!ACCESS_TOKEN || currentWs) return;
    try {
        console.log("🔌 Initializing WS (V3 Binary Mode)...");
        const response = await axios.get("https://api.upstox.com/v3/feed/market-data-feed/authorize", { headers: { 'Authorization': 'Bearer ' + ACCESS_TOKEN, 'Accept': 'application/json' } });
        const WebSocket = require('ws'); 
        currentWs = new WebSocket(response.data.data.authorizedRedirectUri, { followRedirects: true });
        currentWs.binaryType = "arraybuffer"; 

        currentWs.onopen = () => {
            console.log("✅ WebSocket Connected! Subscribing...");
            const binaryMsg = Buffer.from(JSON.stringify({ guid: "bot-" + Date.now(), method: "sub", data: { mode: "ltpc", instrumentKeys: [INSTRUMENT_KEY] } }));
            currentWs.send(binaryMsg);
        };

        currentWs.onmessage = (msg) => {
            try {
                if (!FeedResponse) return;
                const buffer = new Uint8Array(msg.data);
                const message = FeedResponse.decode(buffer);
                const object = FeedResponse.toObject(message, { longs: String, enums: String, bytes: String, defaults: true, oneofs: true });

                if (object.feeds) {
                    for (const key in object.feeds) {
                        const feed = object.feeds[key];
                        let newPrice = feed.ltpc?.ltp || feed.fullFeed?.marketFF?.ltpc?.ltp || feed.fullFeed?.indexFF?.ltpc?.ltp;

                        if (newPrice > 0 && (key.includes("458305") || Object.keys(object.feeds).length === 1)) {
                            lastKnownLtp = newPrice;

                            // 1️⃣ LIVE TRADE TRACKING
                            if (botState.positionType) {
                                let currentProfit = 0;
                                if (botState.positionType === 'LONG') currentProfit = newPrice - botState.entryPrice;
                                if (botState.positionType === 'SHORT') currentProfit = botState.entryPrice - newPrice;
                                
                                if (currentProfit > botState.maxRunUp) botState.maxRunUp = currentProfit;

                                // Trailing SL Logic
                                let newStop = botState.currentStop;
                                let didChange = false;
                                let trailingGap = globalATR * 1.5; 

                                if (currentProfit >= 1000) trailingGap = 500;
                                if (currentProfit >= 600) {
                                    const costSL = botState.entryPrice;
                                    const betterSL = botState.positionType === 'LONG' ? Math.max(botState.currentStop, costSL) : Math.min(botState.currentStop, costSL);
                                    if (newStop !== betterSL) { newStop = betterSL; didChange = true; }
                                }

                                if (botState.positionType === 'LONG') {
                                    const trailingLevel = newPrice - trailingGap;
                                    if (trailingLevel > newStop && trailingLevel > botState.currentStop + 50) { newStop = trailingLevel; didChange = true; }
                                } else {
                                    const trailingLevel = newPrice + trailingGap;
                                    if (trailingLevel < newStop && trailingLevel < botState.currentStop - 50) { newStop = trailingLevel; didChange = true; }
                                }

                                if (didChange) {
                                    botState.currentStop = newStop;
                                    pushToDashboard(); 
                                    modifyExchangeSL(newStop);
                                }
                                
                                if ((botState.positionType === 'LONG' && newPrice <= botState.currentStop) || 
                                    (botState.positionType === 'SHORT' && newPrice >= botState.currentStop)) {
                                     verifyOrderStatus(botState.slOrderId, 'EXIT_CHECK');
                                }
                            }

                            // ------------------------------------------------------
                            // 2️⃣ POST-TRADE MONITORING (EVERY TICK - NO THROTTLE)
                            // ------------------------------------------------------
                            const now = Date.now();
                            for (const oid in botState.activeMonitors) {
                                const session = botState.activeMonitors[oid];
                                
                                // ✅ CAPTURE EVERY SINGLE UPDATE
                                // We store timestamp as raw milliseconds to make searching easier later
                                session.data.push({ t: now, p: newPrice });
                                    
                                // Update Min/Max seen AFTER exit
                                if (newPrice > session.highestAfterExit) session.highestAfterExit = newPrice;
                                if (newPrice < session.lowestAfterExit) session.lowestAfterExit = newPrice;

                                // STOP after 10 Minutes
                                if (now - session.startTime > 600000) {
                                    console.log(`✅ Finished Analyzing Trade ${oid}. Saving Report.`);
                                    
                                    const logIndex = botState.history.findIndex(h => h.id === oid);
                                    if (logIndex !== -1) {
                                        botState.history[logIndex].analysisData = {
                                            maxRunUp: session.maxRunUp,
                                            // Store start time so we can calculate +1min, +5min relative to it
                                            startTime: session.startTime, 
                                            data: session.data,        
                                            highAfter: session.highestAfterExit,
                                            lowAfter: session.lowestAfterExit
                                        };
                                        saveState();
                                    }
                                    delete botState.activeMonitors[oid]; 
                                }
                            }
                            
                            pushToDashboard(); 
                        }
                    }
                }
            } catch (e) { console.error("❌ Decode Logic Error:", e.message); }
        };
        currentWs.onclose = () => { currentWs = null; };
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

// --- VERIFY ORDER (Retry Loop & Real Cost Update) ---
// --- VERIFY ORDER (Starts Recording on Exit) ---
async function verifyOrderStatus(orderId, context) {
    if (!orderId) orderId = await fetchLatestOrderId();
    if (!orderId) return;
    
    let attempts = 0;
    const maxAttempts = (context === 'ENTRY') ? 10 : 2; 

    while (attempts < maxAttempts) {
        attempts++;
        if (context !== 'MANUAL_SYNC' && context !== 'EXIT_CHECK') await new Promise(r => setTimeout(r, 2000)); 

        try {
            const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
            const order = res.data.data.find(o => o.order_id === orderId);
            if (!order) break; 
            
            if (order.status === 'complete') {
                const realPrice = parseFloat(order.average_price);
                const execTime = new Date(order.order_timestamp).toLocaleTimeString();
                
                if (context === 'EXIT_CHECK') {
                    let tradePnL = 0;
                    if (botState.positionType === 'LONG') tradePnL = (realPrice - botState.entryPrice) * botState.quantity;
                    if (botState.positionType === 'SHORT') tradePnL = (botState.entryPrice - realPrice) * botState.quantity;

                    // ✅ START 10-MINUTE RECORDING SESSION
                    botState.activeMonitors[orderId] = {
                        startTime: Date.now(),
                        lastRecordTime: 0,
                        type: botState.positionType, // 'LONG' or 'SHORT'
                        exitPrice: realPrice,
                        entryPrice: botState.entryPrice,
                        maxRunUp: botState.maxRunUp, // Pass the max profit we saw
                        highestAfterExit: realPrice,
                        lowestAfterExit: realPrice,
                        data: [] // Array to store prices
                    };
                    console.log(`🎥 Starting 10-min analysis for Order ${orderId}`);

                    botState.history.unshift({ 
                        date: formatDate(getIST()), time: execTime, type: order.transaction_type, 
                        orderedPrice: order.price, executedPrice: realPrice, id: orderId, 
                        status: "FILLED", pnl: tradePnL, tag: "API_BOT" 
                    });

                    // Reset State
                    botState.positionType = null; botState.slOrderId = null; botState.currentStop = null; botState.maxRunUp = 0;
                } 
                else {
                    botState.entryPrice = realPrice; 
                    botState.maxRunUp = 0; // Reset profit tracker on new entry
                }

                // Update Dashboard Log if existing
                const logIndex = botState.history.findIndex(h => h.id === orderId || (h.status === 'SENT' && h.type === order.transaction_type));
                if (logIndex !== -1) {
                    botState.history[logIndex].executedPrice = realPrice;
                    botState.history[logIndex].time = execTime;
                    botState.history[logIndex].status = "FILLED";
                    botState.history[logIndex].id = orderId;
                }

                await saveState();
                pushToDashboard();
                return;

            } else if (['rejected', 'cancelled'].includes(order.status)) {
                if (context === 'EXIT_CHECK') botState.slOrderId = null;
                else if (context !== 'MANUAL_SYNC') { botState.positionType = null; botState.entryPrice = 0; }
                const log = botState.history.find(h => h.id === orderId);
                if (log) log.status = order.status.toUpperCase();
                await saveState();
                pushToDashboard();
                return;
            }
        } catch (e) { console.log("Verification Error: " + e.message); }
    }
}
// --- PLACE ORDER (Robust Logging) ---
// --- PLACE ORDER (Saves Ordered Price) ---
// --- PLACE ORDER (Saves Initial State Correctly) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    
    // ✅ NEW: CHECK TRADING SWITCH
    if (!botState.isTradingEnabled) { console.log("⏸️ Trading Paused by User."); return false; }

    // ✅ RESTORED: AMO Logic
    const isAmo = !isMarketOpen();
    
    const limitPrice = Math.round(type === "BUY" ? (ltp * 1.003) : (ltp * 0.997)); 
    const slPrice = type === "BUY" ? (ltp - 800) : (ltp + 800);

    try {
        console.log(`🚀 Sending ${type}: ${qty} Lot @ ₹${limitPrice}`);
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, product: "I", validity: "DAY", price: limitPrice, instrument_token: INSTRUMENT_KEY,
            order_type: "LIMIT", transaction_type: type, disclosed_quantity: 0, trigger_price: 0, 
            is_amo: isAmo, // ✅ USES CALCULATED AMO VARIABLE
            tag: "API_BOT" // ✅ NEW: TAG FOR IDENTIFICATION
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = res.data?.data?.order_id;
        
        botState.positionType = type === "BUY" ? 'LONG' : 'SHORT'; 
        botState.entryPrice = limitPrice; 
        botState.quantity = qty;
        botState.currentStop = slPrice;   
        
        // ✅ ADDED TAG: API_BOT
        botState.history.unshift({ 
            date: formatDate(getIST()), 
            time: getIST().toLocaleTimeString(), 
            type: type, 
            orderedPrice: limitPrice,  
            executedPrice: 0,          
            id: orderId || "PENDING", 
            status: "SENT",
            tag: "API_BOT" 
        });
        
        await manageExchangeSL(type, qty, slPrice);
        await saveState();
        pushToDashboard(); 

        if (orderId) verifyOrderStatus(orderId, 'ENTRY');
        return true;
    } catch (e) {
        console.error(`❌ ORDER FAILED: ${e.message}`);
        return false;
    }
}

// --- TOKEN VALIDATION HELPER ---
// ✅ UPDATED: REAL TOKEN VALIDATION
async function validateToken() {
    if (!ACCESS_TOKEN) return false;

    try {
        // "Ping" Upstox to check if the token is still valid
        // We use the User Profile API as a lightweight check
        await axios.get('https://api.upstox.com/v2/user/profile', {
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });
        return true;
    } catch (e) {
        // If Upstox returns 401, the token is definitely Invalid/Revoked
        if (e.response && e.response.status === 401) {
            console.log("⚠️ Token is Invalid/Revoked. Switching to OFFLINE.");
            ACCESS_TOKEN = null; // 🚨 This triggers the Dashboard to show OFFLINE
            
            // Kill the WebSocket too since the token is dead
            if (currentWs) {
                try { currentWs.close(); } catch(err) {}
                currentWs = null;
            }
            
            pushToDashboard(); // Force immediate UI update
            return false;
        }
        // If it's a different error (like network issue), we assume token is OK for now
        return true;
    }
}

// --- CRON & WATCHDOG ---
setInterval(() => {
    const now = getIST();
    // ✅ FIXED: Removed "!ACCESS_TOKEN" check. We MUST login daily to get a fresh token.
    // ✅ TEST MODE: Set to 12:30 PM
    if (now.getHours() === 8 && now.getMinutes() === 30) {
        console.log("⏰ Scheduled Auto-Login Triggered...");
        performAutoLogin(); 
    }
}, 60000);
// TRADING LOOP (Runs every 30s)
// --- TRADING ENGINE (Watcher & Entry) ---
setInterval(async () => {
    // 1. Safety Checks
    await validateToken(); 
    if (!ACCESS_TOKEN || !isApiAvailable()) return;
  
    // 2. WebSocket Watchdog
    if ((lastKnownLtp === 0 || !currentWs) && ACCESS_TOKEN) {
        initWebSocket();
        return; 
    }

    try {
        // 3. Get Data
        const candles = await getMergedCandles();
        if (candles.length > 200) {
            // Extract Data
            const cl = candles.map(c => c[4]);
            const h = candles.map(c => c[2]);
            const l = candles.map(c => c[3]);
            const v = candles.map(c => c[5]);

            // Calculate Indicators
            const e50 = EMA.calculate({period: 50, values: cl});
            const e200 = EMA.calculate({period: 200, values: cl});
            const vAvg = SMA.calculate({period: 20, values: v});
            const atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
            
            // Get Current Values
            const curE50 = e50[e50.length-1];
            const curE200 = e200[e200.length-1];
            const curV = v[v.length-1];
            const curAvgV = vAvg[vAvg.length-1];
            const curA = atr[atr.length-1];
            
            // Calculate Breakout Levels
            const bH = Math.max(...h.slice(-11, -1));
            const bL = Math.min(...l.slice(-11, -1));

            // Update Global ATR for Trailing SL
            globalATR = curA; 

            // 4. Regular Log (Clean, looks exactly like before)
            console.log(`LTP: ${lastKnownLtp} | E50: ${curE50.toFixed(0)} | E200: ${curE200.toFixed(0)} | Vol: ${curV} | Avg Vol: ${curAvgV.toFixed(0)}`);

            // 5. TRADING LOGIC
            // ✅ We check for signals FIRST, ignoring the 'Pause' switch for now
            if (isMarketOpen() && !botState.positionType) {
                 
                 // Define the Buy/Sell Conditions
                 const isBuySignal = (cl[cl.length-2] > e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp > bH);
                 const isSellSignal = (cl[cl.length-2] < e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp < bL);

                 // Act on Signals
                 if (isBuySignal) {
                     // NOW we check the switch
                     if (botState.isTradingEnabled) {
                         // Switch ON: Execute Order
                         botState.positionType = 'LONG'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; 
                         botState.currentStop = lastKnownLtp - (curA * 1.5); 
                         await saveState(); 
                         await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                     } else {
                         // Switch OFF: Log Warning only
                         console.log(`⚠️ FOUND BUY SIGNAL @ ${lastKnownLtp} -> SKIPPED (Trading Paused in Dashboard)`);
                     }
                } 
                else if (isSellSignal) {
                    if (botState.isTradingEnabled) {
                        // Switch ON: Execute Order
                        botState.positionType = 'SHORT'; botState.entryPrice = lastKnownLtp; botState.quantity = MAX_QUANTITY; 
                        botState.currentStop = lastKnownLtp + (curA * 1.5); 
                        await saveState(); 
                        await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    } else {
                         // Switch OFF: Log Warning only
                         console.log(`⚠️ FOUND SELL SIGNAL @ ${lastKnownLtp} -> SKIPPED (Trading Paused in Dashboard)`);
                    }
                }
            } 
        }
    } catch (e) { 
        // Auto-login trigger if token expires
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

app.get('/toggle-trading', async (req, res) => {
    botState.isTradingEnabled = !botState.isTradingEnabled;
    
    // ✅ NEW: Add a visible System Log entry
    const action = botState.isTradingEnabled ? "RESUMED" : "PAUSED";
    const colorLog = botState.isTradingEnabled ? "ACTIVE" : "STOPPED";
    
    botState.history.unshift({
        date: formatDate(getIST()),
        time: getIST().toLocaleTimeString(),
        type: "SYSTEM",        // Shows up as gray text
        orderedPrice: 0,
        executedPrice: 0,
        id: "CMD-" + Date.now().toString().slice(-6),
        status: action,        // Will show "PAUSED" or "RESUMED"
        pnl: 0,
        tag: "MANUAL"
    });

    console.log(`🔘 Trading Manually ${action} by User.`);
    
    await saveState();
    pushToDashboard();
    res.redirect('/');
});

app.get('/delete-log/:id', async (req, res) => {
    const idToRemove = req.params.id;
    
    // 1. Add to Blacklist (So Sync doesn't bring it back)
    if (!botState.hiddenLogIds) botState.hiddenLogIds = []; // Safety check
    botState.hiddenLogIds.push(idToRemove);

    // 2. Remove from current history immediately
    botState.history = botState.history.filter(h => h.id !== idToRemove);
    
    // 3. Recalculate PnL without this trade
    botState.totalPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

    await saveState();
    res.redirect('/');
});

// --- 🏠 DASHBOARD ROUTE (Fixed Position Live Update) ---
app.get('/', (req, res) => {
    // 1. Calculate PnL
    const todayStr = formatDate(getIST()); 
    const todayLogs = botState.history.filter(h => h.date === todayStr);
    const todayPnL = todayLogs.reduce((acc, log) => acc + (log.pnl || 0), 0);
    const historyPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

    // 2. Prepare Logs
    const cleanLogs = todayLogs.filter(t => !t.type.includes('SYSTEM') && t.status !== 'CANCELLED' && t.status !== 'REJECTED');
    const displayLogs = generateLogHTML(cleanLogs);

    res.send(`
        <!DOCTYPE html><html style="background:#0f172a; color:white; font-family:sans-serif;">
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script>
                const source = new EventSource('/live-updates');
                source.onmessage = (e) => {
                    const d = JSON.parse(e.data);
                    document.getElementById('live-price').innerText = '₹' + d.price;
                    document.getElementById('live-pnl').innerText = '₹' + d.pnl;
                    document.getElementById('live-pnl').style.color = parseFloat(d.pnl) >= 0 ? '#4ade80' : '#f87171';
                    document.getElementById('hist-btn-pnl').innerText = 'Total: ₹' + d.historicalPnl;
                    
                    document.getElementById('live-sl').innerText = '₹' + Math.round(d.stop || 0);
                    document.getElementById('exch-sl').innerText = '₹' + Math.round(d.stop || 0);
                    document.getElementById('exch-id').innerText = d.slID || 'NO ORDER';
                    
                    const stat = document.getElementById('live-status');
                    stat.innerText = d.status;
                    stat.style.color = d.status === 'ONLINE' ? '#4ade80' : '#ef4444';

                    // ✅ FIXED: Update Position Text Live
                    const pos = document.getElementById('pos-type');
                    pos.innerText = d.position;
                    pos.style.color = d.position === 'NONE' ? '#facc15' : (d.position === 'LONG' ? '#4ade80' : '#f87171');

                    const btn = document.getElementById('toggle-btn');
                    btn.innerText = d.isTrading ? "🟢 TRADING ON" : "🔴 PAUSED";
                    btn.style.background = d.isTrading ? "#22c55e" : "#ef4444";

                    if(d.logsHTML) document.getElementById('logContent').innerHTML = d.logsHTML;
                };
            </script>
        </head>
        <body style="display:flex; justify-content:center; padding:20px;">
            <div style="width:100%; max-width:650px; background:#1e293b; padding:25px; border-radius:15px;">
                
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h2 style="color:#38bdf8; margin:0;">🥈 Silver Prime Auto</h2>
                    <a href="/toggle-trading" id="toggle-btn" style="padding:8px 15px; border-radius:8px; text-decoration:none; color:white; font-weight:bold; background:${botState.isTradingEnabled?'#22c55e':'#ef4444'}">
                        ${botState.isTradingEnabled?'🟢 TRADING ON':'🔴 PAUSED'}
                    </a>
                </div>
                
                <div style="text-align:center; padding:15px; border:1px solid #334155; border-radius:10px; margin-bottom:15px;">
                    <small style="color:#94a3b8;">LIVE PRICE</small><br><b id="live-price" style="font-size:24px; color:#fbbf24;">₹${lastKnownLtp || '---'}</b>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">LIVE PNL</small><br><b id="live-pnl">₹${calculateLivePnL().live}</b></div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">TODAY'S NET PNL</small><br><b id="todays-pnl" style="color:${todayPnL >= 0 ? '#4ade80' : '#f87171'}">₹${todayPnL.toFixed(2)}</b></div>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">TRAILING SL</small><br><b id="live-sl" style="color:#f472b6;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '---'}</b></div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">EXCHANGE SL</small><br><b id="exch-sl" style="color:#f472b6;">₹${botState.currentStop ? botState.currentStop.toFixed(0) : '---'}</b><br><span id="exch-id" style="font-size:10px; color:#64748b;">${botState.slOrderId || 'NO ORDER'}</span></div>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;">
                        <small style="color:#94a3b8;">POSITION</small><br>
                        <b id="pos-type" style="color:#facc15;">${botState.positionType || 'NONE'}</b>
                    </div>
                    <div style="background:#0f172a; padding:10px; text-align:center; border-radius:8px;"><small style="color:#94a3b8;">STATUS</small><br><b id="live-status" style="color:${ACCESS_TOKEN?'#4ade80':'#ef4444'}">${ACCESS_TOKEN?'ONLINE':'OFFLINE'}</b></div>
                </div>
                
                <div style="margin-bottom:15px;">
                    <a href="/reports" style="display:block; width:100%; padding:15px; background:#334155; color:white; text-align:center; border-radius:8px; text-decoration:none; border:1px solid #475569;">
                        <b>📊 VIEW HISTORICAL REPORTS</b><br>
                        <small id="hist-btn-pnl" style="color:${historyPnL>=0?'#4ade80':'#f87171'}">Total: ₹${historyPnL.toFixed(2)}</small>
                    </a>
                </div>

                <div style="display:flex; gap:10px; margin-bottom:20px;">
                     <form action="/trigger-login" method="POST" style="flex:1;"><button style="width:100%; padding:12px; background:#6366f1; color:white; border:none; border-radius:8px; cursor:pointer;">🤖 AUTO-LOGIN</button></form>
                     <form action="/sync-price" method="POST" style="flex:1;"><button style="width:100%; padding:12px; background:#fbbf24; color:#0f172a; border:none; border-radius:8px; cursor:pointer;">🔄 SYNC PRICE</button></form>
                </div>
                
                <div style="display:grid; grid-template-columns: 1.2fr 0.8fr 1fr 1fr 1fr 1.5fr; gap:5px; padding:5px 10px; color:#94a3b8; border-bottom:1px solid #334155; font-size:11px; margin-bottom:5px;">
                    <span>Time</span> 
                    <span style="text-align:center;">Type</span> 
                    <span style="text-align:right;">Ordered</span> 
                    <span style="text-align:right;">Actual</span> 
                    <span style="text-align:right;">PnL</span>
                    <span style="text-align:right;">Order ID</span>
                </div>
                
                <div id="logContent">${displayLogs}</div>
            </div></body></html>`);
});

app.post('/trigger-login', (req, res) => { performAutoLogin(); res.redirect('/'); });

// --- SYNC PRICE (With PnL Calculation Engine) ---
// --- SYNC PRICE (Fixed PnL Calculation Logic) ---
// --- SYNC PRICE (Preserves History & Dates) ---
// --- SYNC PRICE (Complete: Replay, History Protection, & Manual Tagging) ---
// --- SYNC PRICE (Filters Garbage & Tags Manual Orders) ---
// --- SYNC PRICE (Complete: Filters, Tags, LTP Fallback & History) ---
app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        console.log("🔄 Syncing & Recalculating PnL...");
        
        // 1. FETCH UPSTOX ORDERS (Today's Orders Only)
        const ordRes = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }});
        
        // 2. FILTERING LOGIC
        const myOrders = (ordRes.data?.data || [])
            .filter(o => o.instrument_token && o.instrument_token.includes("458305")) // Silver Only
            .filter(o => o.status !== 'cancelled' && o.status !== 'rejected')         // Ignore Garbage
            // ✅ PERMANENT DELETE SUPPORT (Ignore Blacklisted IDs)
            .filter(o => !botState.hiddenLogIds || !botState.hiddenLogIds.includes(o.order_id)) 
            .sort((a, b) => new Date(a.order_timestamp) - new Date(b.order_timestamp));

        // 3. REPLAY ENGINE: Calculate PnL for TODAY
        let openPos = { side: null, price: 0, qty: 0 };
        const processedLogs = [];
        const todayStr = formatDate(getIST()); 

        myOrders.forEach(order => {
            const realPrice = parseFloat(order.average_price) || 0;
            const limitPrice = parseFloat(order.price) || 0;
            const execTime = new Date(order.order_timestamp).toLocaleTimeString();
            const txnType = order.transaction_type; 
            const status = order.status === 'complete' ? 'FILLED' : order.status.toUpperCase();
            
            let tradePnL = 0; 

            if (order.status === 'complete') {
                const qty = parseInt(order.quantity) || 1;
                // Replay Position Logic
                if (openPos.qty === 0) {
                    openPos.side = txnType;
                    openPos.price = realPrice;
                    openPos.qty = qty;
                }
                else if (openPos.side !== txnType) {
                    if (openPos.side === 'BUY' && txnType === 'SELL') {
                        tradePnL = (realPrice - openPos.price) * openPos.qty;
                    } else if (openPos.side === 'SELL' && txnType === 'BUY') {
                        tradePnL = (openPos.price - realPrice) * openPos.qty;
                    }
                    openPos.qty = 0; openPos.side = null; openPos.price = 0;
                }
            }

            // ✅ SMART TAGGING (Preserve Tags)
            const existingLog = botState.history.find(h => h.id === order.order_id);
            const tag = order.tag || (existingLog ? existingLog.tag : "MANUAL");

            // Create Log
            processedLogs.unshift({
                date: todayStr, 
                time: execTime,
                type: txnType,
                orderedPrice: limitPrice,
                executedPrice: realPrice,
                id: order.order_id,
                status: status,
                pnl: tradePnL !== 0 ? tradePnL : null,
                tag: tag 
            });
        });

        // 4. INTELLIGENT MERGE (Preserve System & Old History)
        botState.history = botState.history.filter(h => {
            if (h.type === 'SYSTEM' || h.type === 'Autologin') return true;
            if (h.date && h.date !== todayStr) return true; // Keep Yesterday's data
            if (!h.date) return true; // Keep Legacy data
            return false; // Remove Today's old trade logs (replaced by fresh sync)
        });

        // Add Fresh "Today" Logs to the top
        botState.history = [...processedLogs, ...botState.history];

        // 5. RECALCULATE TOTAL PNL
        botState.totalPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

        // 6. CHECK ACTIVE POSITION & RESTORE SL
        const posResponse = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
        const pos = (posResponse.data?.data || []).find(p => p.instrument_token && p.instrument_token.includes("458305"));
        
        if (pos && parseInt(pos.quantity) !== 0) {
            const qty = Math.abs(parseInt(pos.quantity));
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = qty;
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);
            
            // ✅ LTP FALLBACK (From Script 5): If WebSocket is quiet, fetch API price
            let currentLtp = lastKnownLtp;
            if (!currentLtp || currentLtp === 0) {
                try {
                    const qRes = await axios.get(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(INSTRUMENT_KEY)}`, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }});
                    currentLtp = qRes.data.data[INSTRUMENT_KEY].last_price;
                    lastKnownLtp = currentLtp; 
                } catch (e) { currentLtp = botState.entryPrice; }
            }

            const riskPoints = 1200; 
            const entrySide = parseInt(pos.quantity) > 0 ? 'BUY' : 'SELL';
            const slPrice = botState.positionType === 'LONG' ? (currentLtp - riskPoints) : (currentLtp + riskPoints);
            
            botState.currentStop = slPrice;
            console.log(`🔄 Sync Found: ${botState.positionType} | SL: ${slPrice}`);
            await manageExchangeSL(entrySide, botState.quantity, slPrice);

        } else { 
            // Clean Reset if no position
            botState.positionType = null; 
            botState.currentStop = 0;
            botState.slOrderId = null;
            botState.quantity = 0;
            console.log("🔄 No open position found (Cleaned).");
        }
        
        await saveState();
    } catch (e) { console.error("Sync Error:", e.message); }
    res.redirect('/');
});

const PORT = process.env.PORT || 10000;

// ✅ NEW ROUTE: One-time PnL Reset
app.post('/reset-pnl', async (req, res) => {
    botState.totalPnL = 0;
    await saveState();
    pushToDashboard();
    res.redirect('/');
});

// --- 📊 REPORTS ROUTE ---
app.get('/reports', (req, res) => {
    // 1. Group Data by Date
    const grouped = {};
    botState.history.forEach(log => {
        if (!log.date || log.type.includes('SYSTEM')) return;
        if (!grouped[log.date]) grouped[log.date] = { date: log.date, trades: [], pnl: 0, wins: 0, losses: 0 };
        
        grouped[log.date].trades.push(log);
        if (log.pnl) {
            grouped[log.date].pnl += log.pnl;
            if (log.pnl > 0) grouped[log.date].wins++;
            else grouped[log.date].losses++;
        }
    });

    const reportRows = Object.values(grouped).sort((a,b) => new Date(b.date) - new Date(a.date));

    // 2. Check if a specific date is selected
    const selectedDate = req.query.date;
    let detailView = "";
    
    if (selectedDate && grouped[selectedDate]) {
        const dayLogs = grouped[selectedDate].trades;
        const dayRows = dayLogs.map(t => {
            // Show Analyze button for losses
            const analyzeBtn = (t.pnl < 0) ? `<a href="/analyze-sl/${t.id}" target="_blank" style="color:#f472b6; font-size:10px;">🔍 ANALYZE</a>` : '';
            return `<div style="padding:10px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; font-size:12px;">
                <span>${t.time}</span>
                <b style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</b>
                <span>₹${t.executedPrice}</span>
                <span style="color:${(t.pnl||0)>=0?'#4ade80':'#f87171'}">₹${(t.pnl||0).toFixed(0)} ${analyzeBtn}</span>
            </div>`;
        }).join('');

        detailView = `
            <div style="margin-top:20px; background:#0f172a; padding:15px; border-radius:10px;">
                <h3 style="color:#fbbf24; margin-top:0;">📅 Details for ${selectedDate}</h3>
                ${dayRows}
            </div>
        `;
    }

    // 3. Render Report Page
    const reportHTML = reportRows.map(r => `
        <a href="/reports?date=${r.date}" style="text-decoration:none; color:white;">
            <div style="display:flex; justify-content:space-between; padding:15px; background:#0f172a; margin-bottom:10px; border-radius:8px; border-left:5px solid ${r.pnl>=0?'#4ade80':'#f87171'};">
                <div><b>${r.date}</b><br><small style="color:#94a3b8;">${r.wins}W / ${r.losses}L</small></div>
                <div style="text-align:right;"><b style="font-size:16px; color:${r.pnl>=0?'#4ade80':'#f87171'}">₹${r.pnl.toFixed(2)}</b></div>
            </div>
        </a>
    `).join('');

    res.send(`
        <!DOCTYPE html><html style="background:#1e293b; color:white; font-family:sans-serif;">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="padding:20px; max-width:600px; margin:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="color:#38bdf8; margin:0;">📊 Historical Reports</h2>
                <a href="/" style="padding:8px 15px; background:#64748b; color:white; text-decoration:none; border-radius:5px;">🏠 Home</a>
            </div>
            
            <div id="calendar-view">${reportHTML}</div>
            ${detailView}
        </body></html>
    `);
});

// --- 🔍 SMART ANALYSIS ROUTE (High-Precision Search) ---
app.get('/analyze-sl/:orderId', async (req, res) => {
    const orderId = req.params.orderId;
    const trade = botState.history.find(h => h.id === orderId);
    if (!trade) return res.send("Trade not found.");

    const activeSession = botState.activeMonitors[orderId];
    const savedData = trade.analysisData;

    // 1. LIVE RECORDING SCREEN
    if (activeSession) {
        const elapsedMin = ((Date.now() - activeSession.startTime) / 60000).toFixed(1);
        const dataPoints = activeSession.data.length;
        return res.send(`
            <body style="background:#0f172a; color:white; font-family:sans-serif; text-align:center; padding:50px;">
                <h1 style="color:#fbbf24;">🎥 Recording Every Tick...</h1>
                <p>High-Precision Analysis in progress.</p>
                <div style="font-size:24px; margin:20px; font-weight:bold;">${elapsedMin} / 10 Minutes</div>
                <div style="color:#94a3b8;">${dataPoints} Price Updates Captured</div>
                <script>setTimeout(() => window.location.reload(), 5000);</script>
            </body>
        `);
    }

    if (!savedData) return res.send("No advanced analysis data available.");

    // 2. GENERATE REPORT
    const { maxRunUp, highAfter, lowAfter, data, startTime } = savedData;
    const exitPrice = parseFloat(trade.executedPrice);
    const isWin = trade.pnl >= 0;
    
    let opinion = "";
    let color = "#cbd5e1"; 

    // Rules Engine
    if (!isWin && maxRunUp >= 600) {
        opinion = "❌ <b>RULE VIOLATION:</b> You saw ₹" + maxRunUp.toFixed(0) + " profit but ended in loss.<br>Rule: <i>'If Profit > 600, Move SL to Cost.'</i>";
        color = "#ef4444"; 
    }
    else if (!isWin) {
        const tradeType = trade.type === 'BUY' ? 'SELL' : 'BUY'; 
        let isStopHunt = false;
        if (tradeType === 'SELL' && highAfter > exitPrice + 200) isStopHunt = true;
        if (tradeType === 'BUY' && lowAfter < exitPrice - 200) isStopHunt = true;

        if (isStopHunt) {
            opinion = "⚠️ <b>BAD LUCK / STOP HUNT:</b> Price reversed in your favor shortly after hitting SL.";
            color = "#fbbf24"; 
        } else {
            opinion = "✅ <b>GOOD EXIT:</b> Price continued against you after SL. You saved capital.";
            color = "#4ade80"; 
        }
    } else {
        opinion = "🎉 <b>PROFITABLE TRADE:</b> Strategy worked.";
        color = "#4ade80";
    }

    // ✅ NEW SEARCH LOGIC: Find price closest to specific timestamps
    // We look for the data point closest to: StartTime + 1 min, +3 min, etc.
    function findPriceAt(minutes) {
        if (!data || data.length === 0) return null;
        const targetTime = startTime + (minutes * 60 * 1000);
        
        // Find closest match
        let closest = data[0];
        let minDiff = Math.abs(data[0].t - targetTime);

        for (let i = 1; i < data.length; i++) {
            const diff = Math.abs(data[i].t - targetTime);
            if (diff < minDiff) {
                minDiff = diff;
                closest = data[i];
            }
        }
        return closest;
    }

    const snap1 = findPriceAt(1);
    const snap3 = findPriceAt(3);
    const snap5 = findPriceAt(5);
    const snap10 = findPriceAt(10);

    res.send(`
        <body style="background:#0f172a; color:white; font-family:sans-serif; padding:30px; display:flex; justify-content:center;">
            <div style="max-width:600px; width:100%; background:#1e293b; padding:25px; border-radius:15px; border:1px solid #334155;">
                <h2 style="color:#38bdf8; margin-top:0;">📊 High-Precision Analysis</h2>
                
                <div style="background:${color}20; border-left:5px solid ${color}; padding:15px; border-radius:5px; margin-bottom:20px;">
                    <strong style="color:${color}; font-size:18px;">${opinion}</strong>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px;">
                    <div style="background:#0f172a; padding:10px; border-radius:8px;">
                        <small style="color:#94a3b8;">MAX PROFIT SEEN</small><br>
                        <b style="color:#4ade80;">₹${maxRunUp.toFixed(0)}</b>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:8px;">
                        <small style="color:#94a3b8;">EXIT PNL</small><br>
                        <b style="color:${trade.pnl>=0?'#4ade80':'#ef4444'}">₹${trade.pnl.toFixed(0)}</b>
                    </div>
                </div>

                <h4 style="color:#94a3b8; border-bottom:1px solid #334155; padding-bottom:5px;">Post-Exit Price Action (10 Mins)</h4>
                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <tr style="color:#64748b; text-align:left;"><th>Time Offset</th><th>Price</th><th>Movement</th></tr>
                    <tr><td>+1 Min</td><td>₹${snap1?.p || '-'}</td><td>${(snap1?.p - exitPrice).toFixed(0)}</td></tr>
                    <tr><td>+3 Min</td><td>₹${snap3?.p || '-'}</td><td>${(snap3?.p - exitPrice).toFixed(0)}</td></tr>
                    <tr><td>+5 Min</td><td>₹${snap5?.p || '-'}</td><td>${(snap5?.p - exitPrice).toFixed(0)}</td></tr>
                    <tr><td>+10 Min</td><td>₹${snap10?.p || '-'}</td><td>${(snap10?.p - exitPrice).toFixed(0)}</td></tr>
                </table>
                <br>
                <div style="font-size:12px; color:#64748b; background:#0f172a; padding:10px; border-radius:5px;">
                    <b>Session Stats:</b> ${data.length} ticks analyzed.<br>
                    Lowest after exit: ₹${lowAfter} <br>
                    Highest after exit: ₹${highAfter}
                </div>
                <br>
                <a href="/" style="display:block; text-align:center; padding:10px; background:#334155; color:white; text-decoration:none; border-radius:5px;">Back to Dashboard</a>
            </div>
        </body>
    `);
});


app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
