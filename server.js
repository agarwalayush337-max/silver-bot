// ✅ Correct CommonJS import for Gemini 3
const { GoogleGenAI } = require("@google/genai");

// ✅ Initialize using the 'new' keyword and the correct class name
const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

async function runStrategicAnalysis(tradeHistory) {
    const response = await client.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: [{ role: "user", parts: [{ text: "Evaluate strategy: " + JSON.stringify(tradeHistory) }] }],
        config: {
            // ✅ NATIVE GEMINI 3 THINKING
            thinkingConfig: {
                thinkingLevel: "high" 
            },
            temperature: 1.0 
        }
    });

    // In this SDK version, .text is a property of the response
    return response.text;
}
const express = require('express');
app.use(require('express').json());
const axios = require('axios');
// --- 🗄️ FIREBASE DATABASE (Secure Env Var Method) ---
const admin = require('firebase-admin');
// We read the JSON string from the Environment Variable
// ⚠️ MAKE SURE YOU ADDED 'FIREBASE_SERVICE_ACCOUNT' IN RENDER SETTINGS!
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) { console.error("❌ Firebase Key Error: Check Render Environment Variable"); }

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = serviceAccount ? admin.firestore() : null;


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

const STRATEGY_RULES = `
**1. RISK MANAGEMENT RULES:**
* **Initial Stop Loss:** 800 points fixed.
* **Move to Cost:** IMMEDIATELY if Profit > ₹600 per lot.
* **Trailing Stop:** If Profit > ₹1000, maintain a Trailing Gap of 500 points.

**2. ENTRY LOGIC (STRICT):**
* **BUY Signal:**
    - Previous Close > Previous EMA50
    - Current Volume > (Average Volume * 1.5)
    - Price > Breakout High (bH)
* **SELL Signal:**
    - Previous Close < Previous EMA50
    - Current Volume > (Average Volume * 1.5)
    - Price < Breakout Low (bL)
`;

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
let botState = { 
    positionType: null, 
    entryPrice: 0, 
    currentStop: null, 
    totalPnL: 0, 
    quantity: 0,
    maxTradeQty: 1,
    history: [], 
    slOrderId: null, 
    isTradingEnabled: true, 
    hiddenLogIds: [],
    maxRunUp: 0,
    lastExitTime: 0,
    activeMonitors: {},
    activeContract: "MCX_FO|458305", // ✅ New field
    contractName: "SILVER MIC FEB"   // ✅ New field
};


// --- 🔒 ENVIRONMENT VARIABLES ---
const { UPSTOX_USER_ID, UPSTOX_PIN, UPSTOX_TOTP_SECRET, API_KEY, API_SECRET, REDIRECT_URI, REDIS_URL } = process.env;



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
        
        // ✅ CHANGED: Show Analyze button for ALL filled trades (Wins & Losses)
        const analyzeBtn = (t.status === 'FILLED') 
            ? `<br><a href="/analyze-sl?id=${t.id}" target="_blank" style="display:inline-block; margin-top:4px; background:#6366f1; color:white; padding:3px 8px; border-radius:4px; font-size:10px; text-decoration:none;">🧠 Analyze</a>` 
            : '';
        
        // Highlight Logic: Dark gradient for paired trades
        const isPaired = pairedIds.has(t.id);
        const bgStyle = isPaired ? 'background:linear-gradient(90deg, #1e293b 0%, #334155 100%); border-left: 3px solid #6366f1;' : 'border-bottom:1px solid #334155;';

        return `<div style="display:grid; grid-template-columns: 1.2fr 0.6fr 0.5fr 1fr 1fr 1fr 1.5fr; gap:5px; padding:10px; font-size:11px; align-items:center; ${bgStyle} margin-bottom:2px; border-radius:4px;">
            <span style="color:#94a3b8;">${t.time}</span> 
            <b style="text-align:center; color:${t.type=='BUY'?'#4ade80':t.type=='SELL'?'#f87171':'#fbbf24'}">${t.type}</b> 
            <span style="text-align:center; color:#cbd5e1;">${t.qty || botState.maxTradeQty}L</span> <span style="text-align:right; color:#cbd5e1;">₹${t.orderedPrice || '-'}</span>
            <span style="text-align:right; font-weight:bold; color:white;">₹${t.executedPrice || '-'}</span> 
            <span style="text-align:right; font-weight:bold; color:${(t.pnl || 0) >= 0 ? '#4ade80' : '#f87171'};">${t.pnl ? '₹'+t.pnl.toFixed(0) : ''} ${analyzeBtn} ${deleteBtn}</span>
            <span style="text-align:right; color:#64748b; font-family:monospace; overflow:hidden; text-overflow:ellipsis;">${t.id || '-'}</span>
        </div>`;
    }).join('');
}
// --- 💾 DATABASE FUNCTIONS ---

// 1. SAVE SETTINGS (Switch, Position, SL - Fast & Frequent)
async function saveSettings() {
    if (!db) return;
    try {
        const settings = {
            positionType: botState.positionType,
            entryPrice: botState.entryPrice,
            currentStop: botState.currentStop,
            slOrderId: botState.slOrderId,
            isTradingEnabled: botState.isTradingEnabled,
            maxRunUp: botState.maxRunUp,
            quantity: botState.quantity,
            totalPnL: botState.totalPnL,
            hiddenLogIds: botState.hiddenLogIds || [],
            updatedAt: new Date().toISOString()
        };
        await db.collection('bot').doc('main').set(settings, { merge: true });
    } catch (e) { console.error("❌ Firebase Save Error:", e.message); }
}

// 2. SAVE TRADE (Logs & Heavy Analysis Data - Permanent)
async function saveTrade(tradeObj) {
    if (!db || !tradeObj || !tradeObj.id) return;
    try {
        await db.collection('trades').doc(tradeObj.id.toString()).set(tradeObj, { merge: true });
    } catch (e) { console.error(`❌ Could not save trade ${tradeObj.id}:`, e.message); }
}

// 3. LOAD STATE (Auto-Migrate from Redis to Firebase)
// --- 💾 SMART LOAD & CLEANUP ---
async function loadState() {
    if (!db) return;
    try {
        console.log("📂 Connecting to Firebase...");
        
        // 1. Load Settings
        const doc = await db.collection('bot').doc('main').get();
        if (doc.exists) {
            const data = doc.data();
            botState.positionType = data.positionType;
            botState.entryPrice = data.entryPrice || 0;
            botState.currentStop = data.currentStop;
            botState.slOrderId = data.slOrderId;
            botState.isTradingEnabled = data.isTradingEnabled ?? true;
            botState.maxRunUp = data.maxRunUp || 0;
            botState.quantity = data.quantity || 0;
            botState.hiddenLogIds = data.hiddenLogIds || [];
        }

        // 2. Load Trades
        const snapshot = await db.collection('trades').orderBy('date', 'desc').limit(200).get();
        let rawHistory = [];
        snapshot.forEach(d => rawHistory.push(d.data()));

        // 3. 🧹 CLEANUP: Remove Duplicates
        // We keep the FIRST instance of every Order ID and discard the rest.
        const seenIds = new Set();
        botState.history = [];
        
        for (const trade of rawHistory) {
            if (!seenIds.has(trade.id)) {
                seenIds.add(trade.id);
                botState.history.push(trade);
            } else {
                // Found a duplicate! (The ghost copy)
                // We don't save it to memory.
                // Optionally: We could delete it from DB here, but filtering memory is safer for now.
                console.log(`🧹 Filtered out duplicate trade: ${trade.id}`);
            }
        }
        
        console.log(`✅ Loaded ${botState.history.length} unique trades.`);

        // 4. MIGRATION CHECK (Only runs if Firebase was totally empty)
        if (rawHistory.length === 0) {
           // ... (Your existing migration logic from Redis goes here if you want to keep it, otherwise remove it) ...
        }

    } catch (e) { console.error("❌ Firebase Load Error:", e.message); }
}
loadState();
async function saveState() { await saveSettings(); } // Backward compatibility wrapper
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
async function manageExchangeSL(side, qty, triggerPrice) {
    if(!ACCESS_TOKEN) return;

    // ✅ Safety: Ensure trigger price is a whole number for MCX
    const roundedTrigger = Math.round(triggerPrice);
    if (!roundedTrigger || roundedTrigger <= 0) {
        console.error("❌ SL Failed: Invalid Trigger Price (" + roundedTrigger + ")");
        return;
    }

    try {
        // If an old SL exists, try to cancel it first
        if (botState.slOrderId) {
            try {
                await axios.delete(`https://api.upstox.com/v2/order/cancel?order_id=${botState.slOrderId}`, { 
                    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
                });
            } catch (ignore) {}
        }
        
        console.log(`📝 Placing SL-M | Qty: ${qty} | Trigger: ${roundedTrigger} (Rounded for MCX)`);

        const res = await axios.post("https://api.upstox.com/v2/order/place", {
            quantity: qty, 
            product: "I", 
            validity: "DAY", 
            price: 0, 
            instrument_token: botState.activeContract, // ✅ Dynamic Contract Support
            order_type: "SL-M", 
            transaction_type: side === "BUY" ? "SELL" : "BUY", 
            trigger_price: roundedTrigger, 
            is_amo: false
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});
        
        // ✅ Correctly capture Order ID for tracking
        botState.slOrderId = res.data?.data?.order_id || res.data?.order_id;
        console.log("✅ SL Placed Order ID:", botState.slOrderId);
        await saveSettings();

    } catch (e) { 
        const errMsg = e.response?.data?.errors?.[0]?.message || e.message;
        console.error(`❌ Exchange SL Placement Failed: ${errMsg}`); 
    }
}

async function modifyExchangeSL(oldStop, newTrigger) {
    if (!botState.slOrderId) return;
    try {
        // ✅ Fix: Use the passed 'oldStop' parameter to show correct transition
        console.log(`🔄 Trailing SL: ${Math.round(oldStop)} ➡️ ${Math.round(newTrigger)}`); 
        await axios.put("https://api.upstox.com/v2/order/modify", {
            order_id: botState.slOrderId,
            order_type: "SL-M",
            quantity: botState.quantity,
            trigger_price: Math.round(newTrigger),
            price: 0,
            validity: "DAY",
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
            console.log(`✅ WebSocket Connected! Subscribing to ${botState.activeContract}...`);
            const binaryMsg = Buffer.from(JSON.stringify({ 
                guid: "bot-" + Date.now(), 
                method: "sub", 
                data: { mode: "ltpc", instrumentKeys: [botState.activeContract] } 
            }));
            currentWs.send(binaryMsg);
        };
        currentWs.onmessage = async (msg) => {
            try {
                if (!FeedResponse) return;
                const buffer = new Uint8Array(msg.data);
                const message = FeedResponse.decode(buffer);
                const object = FeedResponse.toObject(message, { longs: String, enums: String, bytes: String, defaults: true, oneofs: true });

                if (object.feeds) {
                    for (const key in object.feeds) {
                        const feed = object.feeds[key];
                        let newPrice = feed.ltpc?.ltp || feed.fullFeed?.marketFF?.ltpc?.ltp || feed.fullFeed?.indexFF?.ltpc?.ltp;

                        if (newPrice > 0) {
                            const activeToken = botState.activeContract.split('|')[1]; 
                            
                            if (key.includes(activeToken) || Object.keys(object.feeds).length === 1) {
                                lastKnownLtp = newPrice;
                        
                                // 1️⃣ LIVE TRADE TRACKING
                                if (botState.positionType) {
                                    const tradeQty = botState.quantity || 1; // Use current trade quantity
                                    let currentProfit = 0;
                                    if (botState.positionType === 'LONG') currentProfit = (newPrice - botState.entryPrice) * tradeQty;
                                    if (botState.positionType === 'SHORT') currentProfit = (botState.entryPrice - newPrice) * tradeQty;
                                    
                                    if (currentProfit > botState.maxRunUp) botState.maxRunUp = currentProfit;
                                
                                    let newStop = botState.currentStop;
                                    let didChange = false;
                                    let trailingGap = globalATR * 1.5; 
                                
                                
                                    if (currentProfit >= (1000 * tradeQty)) trailingGap = 500;
                                    if (currentProfit >= (600 * tradeQty)) {
                                        const costSL = botState.entryPrice;
                                        const betterSL = botState.positionType === 'LONG' ? Math.max(botState.currentStop, costSL) : Math.min(botState.currentStop, costSL);
                                        if (newStop !== betterSL) { 
                                            console.log(`🛡️ Profit > ${600 * tradeQty} | Moving SL to Cost: ₹${betterSL}`); // ✅ ADD THIS LOG
                                            newStop = betterSL; 
                                            didChange = true; 
                                        }
                                    }

                                    if (botState.positionType === 'LONG') {
                                        const trailingLevel = newPrice - trailingGap;
                                        if (trailingLevel > newStop && trailingLevel > botState.currentStop + 50) { newStop = trailingLevel; didChange = true; }
                                    } else {
                                        const trailingLevel = newPrice + trailingGap;
                                        if (trailingLevel < newStop && trailingLevel < botState.currentStop - 50) { newStop = trailingLevel; didChange = true; }
                                    }

                                    if (didChange) {
                                        const oldStop = botState.currentStop; // Capture old value first
                                        botState.currentStop = newStop;
                                        pushToDashboard(); 
                                        modifyExchangeSL(oldStop, newStop); // Pass both values
                                    }
                                    
                                    // ✅ FIXED: Added proper braces to wrap the console.log and function call
                                    if ((botState.positionType === 'LONG' && newPrice <= botState.currentStop) || 
                                        (botState.positionType === 'SHORT' && newPrice >= botState.currentStop)) {
                                        
                                        if (botState.positionType !== 'EXITING' && botState.positionType !== 'NONE') {
                                            console.log(`🛑 Stop Loss Hit. Verifying ${botState.quantity}L Exit...`);
                                            
                                            const exitOrderId = botState.slOrderId;
                                            const exitType = botState.positionType === 'LONG' ? 'SELL' : 'BUY';
                                            const currentTradeQty = botState.quantity; // ✅ Capture current quantity

                                            // ✅ Placeholder with Dynamic Quantity
                                            botState.history.unshift({ 
                                                date: formatDate(getIST()), 
                                                time: getIST().toLocaleTimeString(), 
                                                type: exitType, 
                                                qty: currentTradeQty, // ✅ Added this line
                                                orderedPrice: botState.currentStop, 
                                                executedPrice: 0, 
                                                id: exitOrderId, 
                                                status: "EXITING", 
                                                tag: "API_BOT" 
                                            });

                                            botState.positionType = 'EXITING'; 
                                            pushToDashboard(); 
                                            verifyOrderStatus(exitOrderId, 'EXIT_CHECK');
                                        }
                                    }
                                }

                                // 2️⃣ POST-TRADE MONITORING
                                const now = Date.now();
                                for (const oid in botState.activeMonitors) {
                                    const session = botState.activeMonitors[oid];
                                    session.data.push({ t: now, p: newPrice });
                                        
                                    if (newPrice > session.highestAfterExit) session.highestAfterExit = newPrice;
                                    if (newPrice < session.lowestAfterExit) session.lowestAfterExit = newPrice;

                                    if (now - session.startTime > 600000) {
                                        console.log(`✅ Finished Analyzing Trade ${oid}. Saving to Firebase.`);
                                        // ✅ Fix: Search history by looking for the ID in ANY field to be safer
                                        const logIndex = botState.history.findIndex(h => h.id == oid || (h.analysisData && h.analysisData.orderId == oid));
                                        
                                        // ✅ SAFETY FIX: Only save if log exists and analysis data is valid
                                        if (logIndex !== -1 && session.data && session.data.length > 0) {
                                            botState.history[logIndex].analysisData = {
                                                maxRunUp: session.maxRunUp,
                                                startTime: session.startTime, 
                                                data: session.data,        
                                                highAfter: session.highestAfterExit,
                                                lowAfter: session.lowestAfterExit
                                            };
                                            await saveTrade(botState.history[logIndex]);
                                        } else {
                                            // Prevents Firestore "Undefined" crash
                                            console.warn(`⚠️ Skipping Firestore save for ${oid}: Log not found or data empty.`);
                                        }
                                        
                                        delete botState.activeMonitors[oid]; 
                                    }
                                }
                                pushToDashboard(); 
                            }
                        }
                    }
                }
            } catch (e) { 
                console.error("❌ Decode Logic Error:", e.message); 
            }
        };
        currentWs.onclose = () => { currentWs = null; };
    } catch (e) { 
        currentWs = null; 
    }
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
    const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(botState.activeContract)}/minutes/5`;
    const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(botState.activeContract)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

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

// --- 🔎 FULL ROBUST VERIFICATION (Blocking Mode) ---
// --- 🔎 INTELLIGENT VERIFICATION (Handles Slippage & Gaps) ---
async function verifyOrderStatus(orderId, context) {
    if (!orderId) return { status: 'FAILED' };

    console.log(`🔎 Verifying Order ${orderId}...`);
    
    let retryCount = 0;
    const maxRetries = 15; // Checks for ~30 seconds total

    while (retryCount < maxRetries) {
        // Wait 2s between checks to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));
        retryCount++;

        try {
            const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { 
                headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
            });
            
            const order = res.data.data.find(o => o.order_id === orderId);
            
            if (!order) {
                console.log(`⚠️ Order ${orderId} not found in exchange history. Retrying...`);
                continue; 
            }

            // 1️⃣ SUCCESS: Order is officially filled
            // 1. SUCCESS: Order Filled
            if (order.status === 'complete') {
                const realPrice = parseFloat(order.average_price);
                const execTime = new Date(order.order_timestamp).toLocaleTimeString();
                
                console.log(`✅ Order Confirmed: ${order.transaction_type} @ ₹${realPrice}`);
                
                // Update Log in Memory
                const logIndex = botState.history.findIndex(h => h.id === orderId || h.id === "PENDING");
                if (logIndex !== -1) {
                    botState.history[logIndex].id = orderId;
                    botState.history[logIndex].executedPrice = realPrice;
                    botState.history[logIndex].time = execTime;
                    botState.history[logIndex].status = "FILLED";
                    botState.history[logIndex].qty = parseInt(order.filled_quantity) || botState.quantity;

                    // ✅ NEW: CALCULATE PNL LIVE
                    // We only calculate PnL if this was an EXIT order
                    if (context === 'EXIT_CHECK') {
                        let tradePnL = 0;
                        const tradeQty = botState.history[logIndex].qty;
                        
                        // If we were LONG, we just SOLD (Profit = Exit - Entry)
                        if (order.transaction_type === 'SELL') {
                            tradePnL = (realPrice - botState.entryPrice) * tradeQty;
                        } 
                        // If we were SHORT, we just BOUGHT (Profit = Entry - Exit)
                        else {
                            tradePnL = (botState.entryPrice - realPrice) * tradeQty;
                        }
                        
                        botState.history[logIndex].pnl = tradePnL;
                        console.log(`💰 Live PnL Calculated: ₹${tradePnL.toFixed(0)}`);
                    }

                    await saveTrade(botState.history[logIndex]); 
                }

                // EXIT LOGIC: Standardized to 'EXIT_CHECK'
                // EXIT LOGIC: Standardized to 'EXIT_CHECK'
                if (context === 'EXIT_CHECK') {
                    botState.lastExitTime = Date.now(); 
                    console.log(`❄️ Cooling period started at: ${new Date().toLocaleTimeString()}`);
                    
                    // ✅ FIX: START HIGH-PRECISION MONITORING
                    console.log(`🎥 Starting 10-Minute Post-Trade Analysis for ${orderId}...`);
                    botState.activeMonitors[orderId] = {
                        startTime: Date.now(),
                        maxRunUp: botState.maxRunUp, // Store the peak profit seen during the trade
                        highestAfterExit: realPrice,
                        lowestAfterExit: realPrice,
                        data: [] // Ticks will be pushed here by WebSocket
                    };
                    
                    // Reset State AFTER initializing monitor
                    botState.positionType = null; 
                    botState.slOrderId = null; 
                    botState.maxRunUp = 0;
                    botState.quantity = 0;
                    botState.entryPrice = 0;
                }

                await saveSettings();
                pushToDashboard(); 
                return { status: 'FILLED', price: realPrice }; 
            }

            // 2️⃣ SLIPPAGE HANDLING: Order is still open/pending after several checks
            if (order.status === 'trigger pending' || order.status === 'open') {
                if (retryCount >= 6) { // If still open after ~12 seconds
                    console.log(`⚠️ SLIPPAGE DETECTED: Order ${orderId} is still ${order.status}. Price likely gapped.`);
                    
                    // ✅ REVERT STATE: Tell the bot it's still in the trade
                    // If the SL order was a 'BUY', it means our position is 'SHORT'
                    botState.positionType = (order.transaction_type === 'BUY') ? 'SHORT' : 'LONG';
                    
                    console.log(`🔄 State Reverted to ${botState.positionType}. WebSocket will resume monitoring.`);
                    pushToDashboard();
                    return { status: 'SLIPPAGE' }; 
                }
            }

            // 3️⃣ FAILURE: Rejected or Cancelled
            if (['rejected', 'cancelled'].includes(order.status)) {
                console.log(`❌ Order Failed: ${order.status_message}`);
                
                const logIndex = botState.history.findIndex(h => h.id === orderId || h.id === "PENDING");
                if (logIndex !== -1) {
                    botState.history[logIndex].id = orderId;
                    botState.history[logIndex].status = order.status.toUpperCase();
                    await saveTrade(botState.history[logIndex]); 
                }
                
                if (context !== 'EXIT_CHECK') { 
                    botState.positionType = null; 
                    botState.quantity = 0;
                }
                
                await saveSettings();
                pushToDashboard();
                return { status: 'FAILED' }; 
            }

        } catch (e) {
            if (e.response && e.response.status === 429) {
                console.log("⚠️ Upstox Rate Limit hit. Pausing 5s...");
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.log("Verification Error: " + e.message);
            }
        }
    }
    
    // Safety Fallback: Unlock state if we timeout to prevent the bot from staying "EXITING"
    if (botState.positionType === 'EXITING') {
        console.log("🛑 Verification TIMEOUT. Reverting state to allow recovery.");
        botState.positionType = null; 
    }
    return { status: 'TIMEOUT' };
}
// --- STRICT PLACE ORDER (With Intent Logging & Error Detail) ---
// --- 🚀 ROBUST V3 PLACE ORDER (Array Handling + Circuit Auto-Correction) ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable() || !botState.isTradingEnabled) return false;

    // 1. Calculate Initial 0.3% Buffer (Rounded to Whole Number for MCX)
    const bufferAmount = ltp * 0.003;
    let limitPrice = type === "BUY" ? Math.round(ltp + bufferAmount) : Math.round(ltp - bufferAmount);

    console.log(`🚀 [INTENT] Sending ${type} Order: ${qty} Lot(s) @ ₹${ltp} | Limit: ₹${limitPrice}`);

    const logId = "PENDING";
    botState.history.unshift({ 
        date: formatDate(getIST()), time: getIST().toLocaleTimeString(), 
        type: type, 
        qty: qty, // ✅ Added: Ensure the placed quantity is logged immediately
        orderedPrice: ltp, executedPrice: 0, id: logId, status: "SENT", tag: "API_BOT" 
    });
    pushToDashboard();

    try {
        // 2. PRIMARY ATTEMPT: Send Order to Upstox V3
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, 
            product: "I", 
            validity: "DAY", 
            price: limitPrice,
            instrument_token: botState.activeContract, 
            order_type: "LIMIT", 
            transaction_type: type, 
            disclosed_quantity: 0, 
            trigger_price: 0, 
            is_amo: !isMarketOpen(), 
            tag: "API_BOT"
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        // ✅ THE V3 FIX: Capture ID from the plural "order_ids" array
        let orderId = res.data?.data?.order_ids?.[0] || res.data?.data?.order_id || res.data?.order_id;

        if (!orderId) {
            console.error("❌ ID Captured Failed. Response Body:", JSON.stringify(res.data));
            throw new Error("No Order ID found in Upstox response.");
        }

        // 3. START ROBUST VERIFICATION
        const result = await verifyOrderStatus(orderId, 'ENTRY');

        if (result.status === 'FILLED') {
            botState.positionType = type === "BUY" ? 'LONG' : 'SHORT';
            botState.entryPrice = result.price; 
            botState.quantity = qty;
            botState.maxRunUp = 0; 

            const slPrice = type === "BUY" ? Math.round(result.price - 800) : Math.round(result.price + 800);
            botState.currentStop = slPrice;
            
            await saveSettings();
            await manageExchangeSL(type, qty, slPrice); 
            return true;
        }
        return false;

    } catch (e) {
        const errorDetail = e.response?.data?.errors?.[0]?.message || e.message;

        // 🛡️ CIRCUIT BREACH AUTO-RECOVERY
        // Scans the error message for "High Price Range:XXXXX.XX" to set the max possible bid
        const highMatch = errorDetail.match(/High Price Range:(\d+\.?\d*)/);
        const lowMatch = errorDetail.match(/Low Price Range:(\d+\.?\d*)/);

        if (errorDetail.includes("Circuit breach") && (highMatch || lowMatch)) {
            const circuitLimitPrice = type === "BUY" ? Math.floor(parseFloat(highMatch[1])) : Math.ceil(parseFloat(lowMatch[1]));
            
            console.error(`⚠️ Circuit Breach! Auto-adjusting to Limit: ₹${circuitLimitPrice}`);
            
            // SECOND ATTEMPT: Place order at exact circuit limit provided by RMS
            try {
                const res2 = await axios.post("https://api.upstox.com/v3/order/place", {
                    quantity: qty, product: "I", validity: "DAY", price: circuitLimitPrice,
                    instrument_token: botState.activeContract, order_type: "LIMIT", 
                    transaction_type: type, tag: "API_BOT"
                }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

                let orderId2 = res2.data?.data?.order_ids?.[0] || res2.data?.data?.order_id;
                return await verifyOrderStatus(orderId2, 'ENTRY');
            } catch (err2) {
                console.error("❌ Final Circuit Retry Failed:", err2.message);
            }
        }

        console.error(`❌ [FAILURE] Order Rejected: ${errorDetail}`);
        botState.positionType = null;
        pushToDashboard();
        await saveSettings();
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
// --- TRADING ENGINE (Watcher & Signal Logic - Runs every 30s) ---
setInterval(async () => {
    await validateToken(); 
    if (!ACCESS_TOKEN || !isApiAvailable()) return;
  
    // 1. WebSocket Watchdog: Reconnect if dropped
    if ((lastKnownLtp === 0 || !currentWs) && ACCESS_TOKEN) {
        initWebSocket();
        return; 
    }

    try {
        // 2. Fetch Candle Data for ACTIVE contract
        const today = new Date();
        const tenDaysAgo = new Date(); tenDaysAgo.setDate(today.getDate() - 10);
        const urlIntraday = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(botState.activeContract)}/minutes/5`;
        const urlHistory = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(botState.activeContract)}/minutes/5/${formatDate(today)}/${formatDate(tenDaysAgo)}`;

        const [histRes, intraRes] = await Promise.all([
            axios.get(urlHistory, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } })),
            axios.get(urlIntraday, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } }).catch(e => ({ data: { data: { candles: [] } } }))
        ]);

        const mergedMap = new Map();
        (histRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        (intraRes.data?.data?.candles || []).forEach(c => mergedMap.set(c[0], c));
        const candles = Array.from(mergedMap.values()).sort((a, b) => new Date(a[0]) - new Date(b[0]));

        if (candles.length > 200) {
            const cl = candles.map(c => c[4]);
            const h = candles.map(c => c[2]);
            const l = candles.map(c => c[3]);
            const v = candles.map(c => c[5]);

            // 3. Indicator Calculations
            const e50 = EMA.calculate({period: 50, values: cl});
            const e200 = EMA.calculate({period: 200, values: cl});
            const vAvg = SMA.calculate({period: 20, values: v});
            const atr = ATR.calculate({high: h, low: l, close: cl, period: 14});
            
            const curE50 = e50[e50.length-1];
            const curE200 = e200[e200.length-1];
            const curV = v[v.length-1];
            const curAvgV = vAvg[vAvg.length-1];
            globalATR = atr[atr.length-1]; 
            
            const bH = Math.max(...h.slice(-11, -1));
            const bL = Math.min(...l.slice(-11, -1));

            // 4. Detailed Indicator Log
            const shortName = botState.contractName.replace("SILVER MIC ", ""); // Turns "SILVER MIC APRIL" into "APRIL"
            console.log(`📊 [${shortName}] LTP: ${lastKnownLtp} | E50: ${curE50.toFixed(0)} | E200: ${curE200.toFixed(0)} | Vol: ${curV} | Avg Vol: ${curAvgV.toFixed(0)}`);
            // 5. Signal Detection Logic (Modified for Cooling Period Reporting)
            if (isMarketOpen() && !botState.positionType) {
                 
                // ✅ Check for signals FIRST
                const isBuySignal = (cl[cl.length-2] > e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp > bH);
                const isSellSignal = (cl[cl.length-2] < e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp < bL);

                // ✅ Check Cooling Period status
                const msSinceExit = Date.now() - botState.lastExitTime;
                const inCoolingPeriod = msSinceExit < 120000;
                const waitSec = Math.ceil((120000 - msSinceExit) / 1000);

                if (isBuySignal) {
                    if (inCoolingPeriod) {
                        console.log(`⚠️ [COOLING] Signal Detected: BUY @ ${lastKnownLtp} | Execution blocked for ${waitSec}s`);
                    } else if (botState.isTradingEnabled) {
                        await placeOrder("BUY", botState.maxTradeQty, lastKnownLtp);
                    } else {
                        console.log(`⚠️ SIGNAL DETECTED: BUY @ ${lastKnownLtp} (Bot Paused)`);
                    }
                } 
                else if (isSellSignal) {
                    if (inCoolingPeriod) {
                        console.log(`⚠️ [COOLING] Signal Detected: SELL @ ${lastKnownLtp} | Execution blocked for ${waitSec}s`);
                    } else if (botState.isTradingEnabled) {
                        await placeOrder("SELL", botState.maxTradeQty, lastKnownLtp);
                    } else {
                        console.log(`⚠️ SIGNAL DETECTED: SELL @ ${lastKnownLtp} (Bot Paused)`);
                    }
                }
                // Log cooling status if no signal but cooling is active
                else if (inCoolingPeriod) {
                    console.log(`⏳ Cooling Period Active: Waiting ${waitSec}s more...`);
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

app.get('/toggle-trading', async (req, res) => {
    botState.isTradingEnabled = !botState.isTradingEnabled;
    const action = botState.isTradingEnabled ? "RESUMED" : "PAUSED";
    
    // Create System Log
    const sysLog = {
        date: formatDate(getIST()),
        time: getIST().toLocaleTimeString(),
        type: "SYSTEM",
        id: "CMD-" + Date.now().toString().slice(-6),
        status: action,
        pnl: 0,
        tag: "MANUAL",
        orderedPrice: 0,
        executedPrice: 0
    };

    botState.history.unshift(sysLog);
    // 🔥 Firebase Save
    if(db) await saveSettings(); 
    
    console.log(`🔘 Trading Manually ${action} by User.`);
    pushToDashboard();
    res.redirect('/');
});

app.get('/delete-log/:id', async (req, res) => {
    const idToRemove = req.params.id;
    if (!botState.hiddenLogIds) botState.hiddenLogIds = [];
    botState.hiddenLogIds.push(idToRemove);

    // Remove from memory
    botState.history = botState.history.filter(h => h.id !== idToRemove);
    botState.totalPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

    // 🔥 Firebase Delete
    try {
        if(db) await db.collection('trades').doc(idToRemove).delete();
        await saveSettings();
    } catch(e) { console.error("Firebase delete error", e); }

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
                
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h2 style="color:#38bdf8; margin:0;">🥈 ${botState.contractName}</h2>
                    <a href="/toggle-trading" id="toggle-btn" style="padding:8px 15px; border-radius:8px; text-decoration:none; color:white; font-weight:bold; background:${botState.isTradingEnabled?'#22c55e':'#ef4444'}">
                        ${botState.isTradingEnabled?'🟢 TRADING ON':'🔴 PAUSED'}
                    </a>
                </div>

                <div style="display:flex; gap:5px; margin-bottom:20px;">
                    <a href="/switch-contract?id=MCX_FO|458305&name=SILVER MIC FEB" 
                       style="flex:1; padding:8px; text-align:center; font-size:10px; border-radius:5px; text-decoration:none; 
                       background:${botState.activeContract.includes('458305') ? '#6366f1' : '#334155'}; color:white; border:1px solid #475569;">
                       FEB CONTRACT
                    </a>
                    <a href="/switch-contract?id=MCX_FO|466029&name=SILVER MIC APRIL" 
                       style="flex:1; padding:8px; text-align:center; font-size:10px; border-radius:5px; text-decoration:none; 
                       background:${botState.activeContract.includes('466029') ? '#6366f1' : '#334155'}; color:white; border:1px solid #475569;">
                       APRIL CONTRACT
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

                <div style="background:#0f172a; padding:15px; border-radius:10px; margin-bottom:15px; border:1px solid #334155;">
                    <form action="/update-qty" method="POST" style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#94a3b8; font-size:14px;">TRADE QUANTITY:</span>
                        <div style="display:flex; gap:5px;">
                            <input type="number" name="qty" value="${botState.maxTradeQty}" min="1" max="10" 
                                style="width:50px; background:#1e293b; color:white; border:1px solid #475569; padding:5px; border-radius:4px; text-align:center;">
                            <button type="submit" style="background:#6366f1; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:12px;">SET</button>
                        </div>
                    </form>
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

// --- SMART SYNC (PnL Replay + Data Protection) ---
// --- SMART SYNC (Full Replay Engine + Dynamic Contract Support) ---
// --- 🔄 FULL SMART SYNC (PnL Replay Engine + Multi-Contract Support) ---
// --- 🔄 FULL SMART SYNC (PnL Replay Engine + Multi-Contract Support) ---
// --- 🔄 FULL PRECISION SYNC (IST DATE LOCK + WEIGHTED PNL + MULTI-QTY) ---
app.post('/sync-price', async (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    try {
        console.log(`🔄 Syncing & Recalculating PnL for ${botState.contractName}...`);
        const activeToken = botState.activeContract.split('|')[1]; 

        // 1. Fetch all orders from Upstox
        const ordRes = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { 
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
        });
        
        // 2. Filter orders specifically for the ACTIVE contract
        const myOrders = (ordRes.data?.data || [])
            .filter(o => o.instrument_token && o.instrument_token.includes(activeToken)) 
            .filter(o => o.status !== 'cancelled' && o.status !== 'rejected')
            .filter(o => !botState.hiddenLogIds || !botState.hiddenLogIds.includes(o.order_id)) 
            .sort((a, b) => new Date(a.order_timestamp) - new Date(b.order_timestamp));

        let openPos = { side: null, price: 0, qty: 0 };
        const processedLogs = [];
        const todayStr = formatDate(getIST()); 

        // 3. Replay Engine: Reconstruct trades to calculate PnL
        myOrders.forEach(order => {
            const realPrice = parseFloat(order.average_price) || 0;
            const limitPrice = parseFloat(order.price) || 0;
            const execTime = new Date(order.order_timestamp).toLocaleTimeString();
            const txnType = order.transaction_type; 
            const status = order.status === 'complete' ? 'FILLED' : order.status.toUpperCase();
            let tradePnL = 0; 

            if (order.status === 'complete') {
                const qty = parseInt(order.quantity) || 1;
                if (openPos.qty === 0) {
                    openPos.side = txnType; openPos.price = realPrice; openPos.qty = qty;
                } else if (openPos.side !== txnType) {
                    if (openPos.side === 'BUY' && txnType === 'SELL') tradePnL = (realPrice - openPos.price) * openPos.qty;
                    else if (openPos.side === 'SELL' && txnType === 'BUY') tradePnL = (openPos.price - realPrice) * openPos.qty;
                    openPos.qty = 0; openPos.side = null; openPos.price = 0;
                }
            }

            // Restore metadata for the trade if it exists
            const existingLog = botState.history.find(h => h.id === order.order_id);
            const preservedData = (existingLog && existingLog.analysisData) ? existingLog.analysisData : null;
            const preservedTag = order.tag || (existingLog ? existingLog.tag : "MANUAL");

            const tradeLog = {
                date: todayStr, time: execTime, type: txnType, 
                qty: parseInt(order.quantity) || 1, // ✅ Dynamic Qty Sync
                orderedPrice: limitPrice,
                executedPrice: realPrice, id: order.order_id, status: status,
                pnl: tradePnL !== 0 ? tradePnL : null, 
                tag: preservedTag,
                analysisData: preservedData // ✅ Now guaranteed to be null or an object
            };
            
            processedLogs.unshift(tradeLog);
            if(db) saveTrade(tradeLog); 
        });

        // 4. Merge system logs back into history
        botState.history = botState.history.filter(h => h.type === 'SYSTEM' || (h.date && h.date !== todayStr));
        botState.history = [...processedLogs, ...botState.history];
        botState.totalPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

        // 5. Update Position Status from Portfolio
        const posResponse = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { 
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });
        const pos = (posResponse.data?.data || []).find(p => p.instrument_token && p.instrument_token.includes(activeToken));
        
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);

            const openOrders = ordRes.data?.data || [];
            const existingSL = openOrders.find(o => o.status === 'trigger pending' && o.order_type === 'SL-M' && o.instrument_token.includes(activeToken));

            if (existingSL) {
                botState.currentStop = parseFloat(existingSL.trigger_price);
                botState.slOrderId = existingSL.order_id;
            } else {
                const currentLtp = lastKnownLtp || botState.entryPrice;
                botState.currentStop = botState.positionType === 'LONG' ? (currentLtp - 1200) : (currentLtp + 1200);
            }
        } else { 
            botState.positionType = null; botState.currentStop = 0; botState.slOrderId = null; botState.quantity = 0;
        }
        
        if(db) await saveSettings();
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
            // ✅ CHANGED: Show Analyze button for ALL filled trades
            const analyzeBtn = (t.status === 'FILLED') ? `<a href="/analyze-sl/${t.id}" target="_blank" style="color:#f472b6; font-size:10px;">🔍 ANALYZE</a>` : '';
            
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

app.get('/analyze-sl', async (req, res) => {
    try {
        const tradeId = req.query.id; // Ensure your dashboard links pass ?id=DOCUMENT_ID
        if (!tradeId) return res.send("Error: No Trade ID provided.");

        // 1. Fetch Trade Data
        const doc = await db.collection('trades').doc(tradeId).get();
        if (!doc.exists) return res.send("Trade not found.");
        const t = doc.data();

        // 2. Prepare Data for AI
        const tradeContext = {
            Date: new Date(t.timestamp).toLocaleString("en-IN"),
            Type: t.type,
            BuyAt: t.buyPrice,
            SellAt: t.sellPrice,
            ProfitLoss: t.pnl,
            Ticks: t.analysisData // The recorded price movement
        };

        // 3. AI Analysis Request (Dynamic Verdict)
        const prompt = `
            Act as a strict trading coach. Review this Silver MIC trade.
            
            **MY STRATEGY RULES:**
            ${STRATEGY_RULES}

            **TRADE DATA:**
            ${JSON.stringify(tradeContext)}

            **TASK:**
            1. Analyze the price ticks to see if I missed an opportunity to trail my SL.
            2. Give a "VERDICT": strictly state if I followed the rules or failed.
            3. Do NOT mention "AI Model" or "Simulation". Speak directly to me.
        `;

        const result = await client.models.generateContent({
            model: "gemini-3-pro-preview",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { thinkingConfig: { thinkingLevel: "high" } }
        });

        const analysisText = result.text.replace(/\n/g, '<br>');

        // 4. Render the HTML Report
        res.send(`
            <body style="background:#0f172a; color:white; font-family:sans-serif; padding:20px;">
                <div style="max-width:800px; margin:auto; background:#1e293b; border-radius:12px; border:1px solid #475569; overflow:hidden;">
                    
                    <div style="background:#334155; padding:20px; border-bottom:1px solid #475569;">
                        <h2 style="margin:0; color:#38bdf8;">📊 Trade Analysis</h2>
                        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:15px; margin-top:15px; font-size:0.9em;">
                            <div><strong>🕒 Time:</strong> ${tradeContext.Date}</div>
                            <div><strong>🏷️ Type:</strong> <span style="color:${t.type=='BUY'?'#4ade80':'#f87171'}">${t.type}</span></div>
                            <div><strong>💰 P/L:</strong> <span style="color:${t.pnl>=0?'#4ade80':'#f87171'}">₹${t.pnl}</span></div>
                            <div><strong>📉 Sell:</strong> ${t.sellPrice}</div>
                            <div><strong>📈 Buy:</strong> ${t.buyPrice}</div>
                        </div>
                    </div>

                    <div style="padding:30px; line-height:1.6; color:#e2e8f0;">
                        ${analysisText}
                    </div>

                    <div style="background:#0f172a; padding:20px; border-top:1px solid #475569;">
                        <h3 style="color:#94a3b8; margin-top:0;">💬 Ask about this trade</h3>
                        <div id="chatHistory" style="margin-bottom:15px;"></div>
                        
                        <div style="display:flex; gap:10px;">
                            <input type="text" id="userQuestion" placeholder="Ex: Why did my SL hit so early?" 
                                   style="flex:1; padding:12px; border-radius:6px; border:none; background:#334155; color:white;">
                            <button onclick="askAI('${tradeId}')" 
                                    style="padding:12px 24px; background:#6366f1; color:white; border:none; border-radius:6px; cursor:pointer;">
                                Ask
                            </button>
                        </div>
                        <p id="loading" style="display:none; color:#fbbf24; font-size:0.9em;">Thinking...</p>
                    </div>

                    <div style="padding:20px; text-align:center;">
                        <a href="/" style="color:#94a3b8; text-decoration:none;">← Back to Dashboard</a>
                    </div>
                </div>

                <script>
                    async function askAI(id) {
                        const question = document.getElementById('userQuestion').value;
                        if(!question) return;

                        document.getElementById('loading').style.display = 'block';
                        const historyDiv = document.getElementById('chatHistory');
                        
                        // Show user question immediately
                        historyDiv.innerHTML += '<div style="background:#334155; padding:10px; margin:5px 0; border-radius:5px; text-align:right;">' + question + '</div>';

                        // Send to server
                        const res = await fetch('/ask-trade-question', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ tradeId: id, question: question })
                        });
                        
                        const data = await res.json();
                        
                        // Show AI Response
                        historyDiv.innerHTML += '<div style="background:#1e293b; border:1px solid #6366f1; padding:10px; margin:5px 0; border-radius:5px;">🤖 ' + data.answer + '</div>';
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('userQuestion').value = '';
                    }
                </script>
            </body>
        `);

    } catch (e) {
        console.error(e);
        res.send("Analysis Failed: " + e.message);
    }
});

app.post('/ask-trade-question', async (req, res) => {
    try {
        console.log("💬 Chat Request Received");
        const { tradeId, question } = req.body;
        
        // 1. Fetch the trade again so AI knows the context
        const doc = await db.collection('trades').doc(tradeId).get();
        if (!doc.exists) return res.json({ answer: "Error: Trade not found." });
        const t = doc.data();

        // 2. Send context + Question to Gemini 3.0
        const result = await client.models.generateContent({
            model: "gemini-3-pro-preview",
            contents: [{ 
                role: "user", 
                parts: [{ text: `
                    SYSTEM: You are a strict trading coach.
                    RULES: ${STRATEGY_RULES}
                    
                    CONTEXT: User is asking about a specific trade.
                    Trade Data: Type=${t.type}, P/L=${t.pnl}, Buy=${t.buyPrice}, Sell=${t.sellPrice}, Time=${t.timestamp}.
                    
                    USER QUESTION: "${question}"
                    
                    ANSWER: Keep it brief, specific to this trade, and based on the rules.
                ` }] 
            }]
        });

        // 3. Send AI answer back to the chat box
        res.json({ answer: result.text });

    } catch (e) {
        console.error("Chat Error:", e);
        res.status(500).json({ answer: "Server Error: " + e.message });
    }
});

// 👆👆👆 END OF STEP 3 👆👆👆


// ... [Bottom of file] ...
app.listen(port, () => {
    console.log(`Server running...`);
});


// --- 🧠 AI STRATEGY OPTIMIZATION (Historical Analysis) ---
app.get('/ai-overall-optimization', async (req, res) => {
    try {
        console.log("🧠 Gemini 3.0 Flash: Starting Global Strategy Analysis...");
        
        // Fetch your Firebase logs
        const snapshot = await db.collection('trades').get();
        let tradeLogs = [];
        snapshot.forEach(doc => tradeLogs.push(doc.data()));

        // ✅ Correct SDK call with Thinking Capability
        const result = await client.models.generateContent({
            model: "gemini-3-pro-preview", 
            contents: [{ 
                role: "user", 
                parts: [{ text: `Analyze my Silver trading strategy performance: ${JSON.stringify(tradeLogs)}` }] 
            }],
            config: {
                thinkingConfig: {
                    includeThoughts: true, 
                    thinkingLevel: "high" // 🧠 Max reasoning for your stop-loss logic
                },
                temperature: 1.0 
            }
        });

        // ✅ The new SDK uses .text() as a function
        const aiResponse = result.text.replace(/\n/g, '<br>'); // ✅ Works (it's a string)
        res.send(`
            <body style="background:#0f172a; color:white; font-family:sans-serif; padding:40px;">
                <div style="max-width:800px; margin:auto; background:#1e293b; padding:30px; border-radius:15px; border:1px solid #4f46e5;">
                    <h1 style="color:#38bdf8;">🧠 Strategy Optimization (Gemini 3.0 Flash)</h1>
                    <div style="line-height:1.8; color:#e2e8f0;">${aiResponse}</div>
                    <br><a href="/" style="display:inline-block; padding:10px 20px; background:#6366f1; color:white; text-decoration:none; border-radius:8px;">🏠 Back to Dashboard</a>
                </div>
            </body>
        `);
    } catch (e) {
        console.error("AI Error:", e);
        res.status(500).send("AI Strategy Error: " + e.message);
    }
});;

app.get('/switch-contract', async (req, res) => {
    const newId = req.query.id;
    const newName = req.query.name;

    // 🛑 TEMPORARILY REMOVED: Position check bypassed as requested
    // if (botState.positionType) { ... }

    if (!newId || newId === botState.activeContract) return res.redirect('/');

    const oldName = botState.contractName;

    // 1. Unsubscribe from old contract
    if (currentWs && currentWs.readyState === 1) {
        const unsubMsg = Buffer.from(JSON.stringify({ 
            guid: "unsub-" + Date.now(), 
            method: "unsub", 
            data: { mode: "ltpc", instrumentKeys: [botState.activeContract] } 
        }));
        currentWs.send(unsubMsg);
    }

    // 2. Update State
    botState.activeContract = newId;
    botState.contractName = newName;
    lastKnownLtp = 0; 

    // 3. Log the change
    const sysLog = {
        date: formatDate(getIST()),
        time: getIST().toLocaleTimeString(),
        type: "SYSTEM",
        id: "SWITCH-" + Date.now().toString().slice(-4),
        status: "CONTRACT_CHANGED",
        pnl: 0,
        tag: "MANUAL",
        orderedPrice: 0,
        executedPrice: 0,
        reason: `Changed from ${oldName} to ${newName}`
    };
    botState.history.unshift(sysLog);

    // 4. Resubscribe to new contract
    if (currentWs && currentWs.readyState === 1) {
        const subMsg = Buffer.from(JSON.stringify({ 
            guid: "sub-" + Date.now(), 
            method: "sub", 
            data: { mode: "ltpc", instrumentKeys: [botState.activeContract] } 
        }));
        currentWs.send(subMsg);
    }

    await saveSettings();
    console.log(`🔄 Contract Switched: ${oldName} ➡️ ${newName}`);
    res.redirect('/');
});

app.post('/update-qty', async (req, res) => {
    const newQty = parseInt(req.body.qty);
    if (newQty > 0 && newQty <= 10) {
        botState.maxTradeQty = newQty;
        if (db) await saveSettings();
        console.log(`🔢 Next Trade Qty set to: ${newQty}`);
    }
    res.redirect('/');
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
