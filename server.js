const express = require('express');
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
    history: [], 
    slOrderId: null, 
    isTradingEnabled: true, 
    hiddenLogIds: [],
    maxRunUp: 0, 
    activeMonitors: {},
    activeContract: "MCX_FO|458305", // ✅ New field
    contractName: "SILVER MIC FEB"   // ✅ New field
};

const MAX_QUANTITY = 1;

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
        const analyzeBtn = (t.status === 'FILLED') ? `<br><a href="/analyze-sl/${t.id}" target="_blank" style="color:#f472b6; font-size:10px; text-decoration:none;">🔍</a>` : '';
        
        // Highlight Logic: Dark gradient for paired trades
        const isPaired = pairedIds.has(t.id);
        const bgStyle = isPaired ? 'background:linear-gradient(90deg, #1e293b 0%, #334155 100%); border-left: 3px solid #6366f1;' : 'border-bottom:1px solid #334155;';

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
            instrument_token: botState.activeContract,
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
                                    let currentProfit = 0;
                                    if (botState.positionType === 'LONG') currentProfit = (newPrice - botState.entryPrice) * botState.quantity;
                                    if (botState.positionType === 'SHORT') currentProfit = (botState.entryPrice - newPrice) * botState.quantity;
                                    
                                    if (currentProfit > botState.maxRunUp) botState.maxRunUp = currentProfit;

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

                                // 2️⃣ POST-TRADE MONITORING
                                const now = Date.now();
                                for (const oid in botState.activeMonitors) {
                                    const session = botState.activeMonitors[oid];
                                    session.data.push({ t: now, p: newPrice });
                                        
                                    if (newPrice > session.highestAfterExit) session.highestAfterExit = newPrice;
                                    if (newPrice < session.lowestAfterExit) session.lowestAfterExit = newPrice;

                                    if (now - session.startTime > 600000) {
                                        console.log(`✅ Finished Analyzing Trade ${oid}. Saving to Firebase.`);
                                        const logIndex = botState.history.findIndex(h => h.id === oid);
                                        if (logIndex !== -1) {
                                            botState.history[logIndex].analysisData = {
                                                maxRunUp: session.maxRunUp,
                                                startTime: session.startTime, 
                                                data: session.data,        
                                                highAfter: session.highestAfterExit,
                                                lowAfter: session.lowestAfterExit
                                            };
                                            await saveTrade(botState.history[logIndex]);
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
async function verifyOrderStatus(orderId, context) {
    if (!orderId) return { status: 'FAILED' };

    console.log(`🔎 Verifying Order ${orderId}...`);
    
    // Safety counter to prevent infinite loops if API is down
    let retryCount = 0;
    const maxRetries = 20; 

    while (retryCount < maxRetries) {
        // Wait 2s normally between checks
        await new Promise(r => setTimeout(r, 2000));
        retryCount++;

        try {
            const res = await axios.get("https://api.upstox.com/v2/order/retrieve-all", { 
                headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Accept': 'application/json' }
            });
            
            const order = res.data.data.find(o => o.order_id === orderId);
            
            if (!order) {
                console.log(`⚠️ Order ${orderId} not found yet in history. Retrying (${retryCount}/${maxRetries})...`);
                continue; 
            }

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
                    // 🔥 Save permanent trade record to Firebase
                    await saveTrade(botState.history[logIndex]); 
                }

                // EXIT LOGIC: Start high-precision monitoring if this was a trade exit
                if (context === 'EXIT_CHECK') {
                    botState.activeMonitors[orderId] = {
                        startTime: Date.now(), 
                        lastRecordTime: 0, 
                        type: botState.positionType,
                        entryPrice: botState.entryPrice, 
                        maxRunUp: botState.maxRunUp,
                        highestAfterExit: realPrice, 
                        lowestAfterExit: realPrice, 
                        data: []
                    };
                    botState.positionType = null; 
                    botState.slOrderId = null; 
                    botState.maxRunUp = 0;
                }

                await saveSettings();
                pushToDashboard();
                return { status: 'FILLED', price: realPrice }; 
            }

            // 2. FAILURE: Rejected or Cancelled
            if (['rejected', 'cancelled'].includes(order.status)) {
                console.log(`❌ Order Failed: ${order.status_message}`);
                
                const logIndex = botState.history.findIndex(h => h.id === orderId || h.id === "PENDING");
                if (logIndex !== -1) {
                    botState.history[logIndex].id = orderId;
                    botState.history[logIndex].status = order.status.toUpperCase();
                    botState.history[logIndex].executedPrice = 0;
                    await saveTrade(botState.history[logIndex]); 
                }
                
                // If entry fails, reset position state so bot can try again
                if (context !== 'EXIT_CHECK') { botState.positionType = null; }
                
                await saveSettings();
                pushToDashboard();
                return { status: 'FAILED' }; 
            }

        } catch (e) {
            // ✅ HANDLE 429 ERROR (Rate Limit) - Crucial 30-line section
            if (e.response && e.response.status === 429) {
                console.log("⚠️ Upstox Rate Limit (429) hit during verification. Pausing 5 seconds...");
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.log("Verification Network Error: " + e.message);
            }
        }
    }
    
    console.log(`🛑 Verification TIMEOUT for ${orderId}. Checking latest state...`);
    return { status: 'TIMEOUT' };
}
// --- STRICT PLACE ORDER (With Intent Logging & Error Detail) ---
// --- 🚀 UPDATED PLACE ORDER: With 0.3% Buffer & Trigger Log ---
async function placeOrder(type, qty, ltp) {
    if (!ACCESS_TOKEN || !isApiAvailable()) return false;
    if (!botState.isTradingEnabled) return false;

    // ✅ STEP 1: Calculate Buffer (0.3%) for Limit Price
    // For BUY: We bid 0.3% HIGHER to ensure immediate fill
    // For SELL: We bid 0.3% LOWER to ensure immediate fill
    const bufferPercent = 0.003; 
    const bufferAmount = ltp * bufferPercent;
    const limitPrice = type === "BUY" 
        ? Math.round((ltp + bufferAmount) * 20) / 20  // Round to nearest 0.05
        : Math.round((ltp - bufferAmount) * 20) / 20;

    // ✅ STEP 2: LOG INTENT (As requested: LTP and Trigger Price)
    console.log(`🚀 [INTENT] Sending ${type} Order: ${qty} Lot(s) @ ₹${ltp} | Limit Trigger: ₹${limitPrice}`);

    // Initialize Log (PENDING)
    const logId = "PENDING";
    botState.history.unshift({ 
        date: formatDate(getIST()), 
        time: getIST().toLocaleTimeString(), 
        type: type, 
        orderedPrice: ltp, 
        executedPrice: 0, 
        id: logId, 
        status: "SENT", 
        tag: "API_BOT" 
    });
    pushToDashboard();

    try {
        // ✅ STEP 3: SEND ORDER (Using Calculated Limit Price)
        const res = await axios.post("https://api.upstox.com/v3/order/place", {
            quantity: qty, 
            product: "I", 
            validity: "DAY", 
            price: limitPrice, // Using buffer price here
            instrument_token: botState.activeContract,
            order_type: "LIMIT", 
            transaction_type: type, 
            disclosed_quantity: 0, 
            trigger_price: 0, 
            is_amo: !isMarketOpen(), 
            tag: "API_BOT"
        }, { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }});

        const orderId = res.data?.data?.order_id || res.data?.order_id;
        
        if (!orderId) throw new Error("No Order ID returned from Upstox API");

        // ✅ STEP 4: VERIFY FILLED STATUS
        const result = await verifyOrderStatus(orderId, 'ENTRY');

        if (result.status === 'FILLED') {
            botState.positionType = type === "BUY" ? 'LONG' : 'SHORT';
            botState.entryPrice = result.price; 
            botState.quantity = qty;
            botState.maxRunUp = 0; 

            // Calculate Stop Loss (Using globalATR)
            const slPrice = type === "BUY" ? (result.price - 800) : (result.price + 800);
            botState.currentStop = slPrice;
            
            await saveSettings();
            await manageExchangeSL(type, qty, slPrice); 
            return true;
        } 
        return false;

    } catch (e) {
        const errorDetail = e.response?.data?.errors?.[0]?.message || e.message;
        console.error(`❌ [FAILURE] Order Request Rejected: ${errorDetail}`);
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
            // 5. Execute Signal Logic
            if (isMarketOpen() && !botState.positionType) {
                 const isBuySignal = (cl[cl.length-2] > e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp > bH);
                 const isSellSignal = (cl[cl.length-2] < e50[e50.length-2] && curV > (curAvgV * 1.5) && lastKnownLtp < bL);

                 if (isBuySignal) {
                     if (botState.isTradingEnabled) {
                         await placeOrder("BUY", MAX_QUANTITY, lastKnownLtp);
                     } else {
                         console.log(`⚠️ SIGNAL DETECTED: BUY @ ${lastKnownLtp} (Paused)`);
                     }
                } 
                else if (isSellSignal) {
                    if (botState.isTradingEnabled) {
                        await placeOrder("SELL", MAX_QUANTITY, lastKnownLtp);
                    } else {
                         console.log(`⚠️ SIGNAL DETECTED: SELL @ ${lastKnownLtp} (Paused)`);
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

        // 3. 🧠 REPLAY ENGINE: Reconstruct trades to calculate PnL
        myOrders.forEach(order => {
            const realPrice = parseFloat(order.average_price) || 0;
            const limitPrice = parseFloat(order.price) || 0;
            const execTime = new Date(order.order_timestamp).toLocaleTimeString();
            const txnType = order.transaction_type; 
            const status = order.status === 'complete' ? 'FILLED' : order.status.toUpperCase();
            let tradePnL = 0; 

            if (order.status === 'complete') {
                const qty = parseInt(order.quantity) || 1;
                // If no open position, this is the entry
                if (openPos.qty === 0) {
                    openPos.side = txnType; 
                    openPos.price = realPrice; 
                    openPos.qty = qty;
                } 
                // If opposite side, this is an exit -> Calculate PnL
                else if (openPos.side !== txnType) {
                    if (openPos.side === 'BUY' && txnType === 'SELL') {
                        tradePnL = (realPrice - openPos.price) * openPos.qty;
                    } else if (openPos.side === 'SELL' && txnType === 'BUY') {
                        tradePnL = (openPos.price - realPrice) * openPos.qty;
                    }
                    openPos.qty = 0; openPos.side = null; openPos.price = 0;
                }
            }

            // 4. PRESERVE DATA: Keep metadata for the trade if it already exists
            const existingLog = botState.history.find(h => h.id === order.order_id);
            const preservedData = existingLog ? existingLog.analysisData : null;
            const preservedTag = order.tag || (existingLog ? existingLog.tag : "MANUAL");

            const tradeLog = {
                date: todayStr, 
                time: execTime, 
                type: txnType, 
                orderedPrice: limitPrice,
                executedPrice: realPrice, 
                id: order.order_id, 
                status: status,
                pnl: tradePnL !== 0 ? tradePnL : null, 
                tag: preservedTag,
                analysisData: preservedData 
            };
            
            processedLogs.unshift(tradeLog);
            if(db) saveTrade(tradeLog); 
        });

        // 5. MERGE: Update history and total PnL
        botState.history = botState.history.filter(h => h.type === 'SYSTEM' || (h.date && h.date !== todayStr));
        botState.history = [...processedLogs, ...botState.history];
        botState.totalPnL = botState.history.reduce((acc, log) => acc + (log.pnl || 0), 0);

        // 6. PORTFOLIO SYNC: Check actual live position
        const posResponse = await axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', { 
            headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
        });
        const pos = (posResponse.data?.data || []).find(p => p.instrument_token && p.instrument_token.includes(activeToken));
        
        if (pos && parseInt(pos.quantity) !== 0) {
            botState.positionType = parseInt(pos.quantity) > 0 ? 'LONG' : 'SHORT';
            botState.quantity = Math.abs(parseInt(pos.quantity));
            botState.entryPrice = parseFloat(pos.buy_price) || parseFloat(pos.average_price);

            // Re-sync the Stop Loss order if it exists on exchange
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
