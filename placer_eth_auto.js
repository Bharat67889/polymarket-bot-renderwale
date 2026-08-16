const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

require("dotenv").config();
const axios = require("axios");
const {
  ClobClient,
  Chain,
  Side,
  OrderType,
  AssetType
} = require("@polymarket/clob-client-v2");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const TRADE_AMOUNT = 5; 
const BUY_PRICE = 0.05; 
const MAX_FUTURE_SLOTS_TO_SCAN = 300; 
const SLOTS_TO_TARGET = 3; // Top 3 Furthest slots ko simultaneously check aur fill karega
const SCAN_INTERVAL_MS = 1 * 60 * 1000; // Har 1 minute me auto-scan hoga
 
const SIGNATURE_TYPE = 3; 
const FUNDER_ADDRESS = "0x477dA82D73bc10f70Ad0978293B470042e3262cA";
const TARGET_SHEET_NAME = "eth5minplaced";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendToGoogleSheet(rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;
  try {
    await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: TARGET_SHEET_NAME, 
      rows: rowsToSend 
    }, { timeout: 30000 });
    console.log(`✅ [SHEET SYNC] ${rowsToSend.length} orders logged to '${TARGET_SHEET_NAME}'`);
  } catch (err) {
    console.log(`❌ [SHEET ERROR] Failed sending log to '${TARGET_SHEET_NAME}'`);
  }
}

async function fetchSingleEthMarket(slug) {
  try {
    const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout: 2500 });
    const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);
    if (market) return { slug, title: res.data[0].title, market };
  } catch (e) { return null; }
  return null;
}

async function runAutoPlacer() {
  console.log("\n==================================================");
  console.log(`🚀 [${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET] Scanning Furthest ${SLOTS_TO_TARGET} ETH 5M Markets...`);
  console.log("==================================================");
  
  if (!process.env.POLY_PRIVATE_KEY) {
    console.log("❌ Error: POLY_PRIVATE_KEY missing in .env file!");
    return;
  }

  let pk = process.env.POLY_PRIVATE_KEY.startsWith("0x") ? process.env.POLY_PRIVATE_KEY : "0x" + process.env.POLY_PRIVATE_KEY;
  const walletClient = createWalletClient({ account: privateKeyToAccount(pk), transport: http("https://polygon-rpc.com") });
  const initClient = new ClobClient({ host: "https://clob.polymarket.com", chain: Chain.POLYGON, signer: walletClient, signatureType: SIGNATURE_TYPE, funderAddress: FUNDER_ADDRESS });
  
  let apiCreds;
  try { apiCreds = await initClient.createOrDeriveApiKey(); } catch(e) { apiCreds = await initClient.deriveApiKey(); }

  const authClient = new ClobClient({
    host: "https://clob.polymarket.com", chain: Chain.POLYGON, signer: walletClient, 
    creds: apiCreds, funderAddress: FUNDER_ADDRESS, signatureType: SIGNATURE_TYPE
  });

  const now = Math.floor(Date.now() / 1000);
  const current5mSlot = now - (now % 300);
  
  // Collect Top 3 Furthest Active Slots
  const targetMarkets = [];
  for (let i = MAX_FUTURE_SLOTS_TO_SCAN; i >= 1; i--) {
    const slug = `eth-updown-5m-${current5mSlot + (i * 300)}`;
    const data = await fetchSingleEthMarket(slug);
    if (data) {
      targetMarkets.push(data);
      if (targetMarkets.length >= SLOTS_TO_TARGET) break;
    }
  }
  
  if (targetMarkets.length === 0) { 
    console.log("❌ No active future slots found."); 
    return; 
  }

  console.log(`🎯 Found ${targetMarkets.length} active furthest candidate slots. Checking order coverage...`);

  const sheetRowsToLog = [];

  // Iterate over all 3 furthest markets (chronological order)
  for (const foundMarket of targetMarkets.reverse()) {
    const marketId = foundMarket.market.conditionId;
    const tokenIds = typeof foundMarket.market.clobTokenIds === "string" ? JSON.parse(foundMarket.market.clobTokenIds) : foundMarket.market.clobTokenIds;

    try {
      const openOrders = await authClient.getOpenOrders({ market: marketId });
      if (openOrders && openOrders.length > 0) {
        console.log(`⚠️ Active order already exists on: ${foundMarket.slug}. Skipping.`);
        continue;
      }
    } catch (err) { /* silent */ }

    console.log(`⏳ Placing 5¢ orders on: ${foundMarket.title} (${foundMarket.slug})...`);
    try {
      const upOrder = await authClient.createOrder({ tokenID: tokenIds[0], price: BUY_PRICE, side: Side.BUY, size: TRADE_AMOUNT, feeRateBps: 0 }, { tickSize: "0.01" });
      const upRes = await authClient.postOrder(upOrder, OrderType.GTC);
      
      const downOrder = await authClient.createOrder({ tokenID: tokenIds[1], price: BUY_PRICE, side: Side.BUY, size: TRADE_AMOUNT, feeRateBps: 0 }, { tickSize: "0.01" });
      const downRes = await authClient.postOrder(downOrder, OrderType.GTC);
      
      const timeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      console.log(`   ✅ SUCCESS: UP @ 5¢ [${upRes.status}] | DOWN @ 5¢ [${downRes.status}]`);

      sheetRowsToLog.push([
        timeET, 
        foundMarket.slug, 
        foundMarket.title, 
        "PLACED", 
        `5 Shares @ $${BUY_PRICE}`, 
        `UP & DOWN (5¢)`
      ]);

      await sleep(1000); // 1 sec cooldown between orders
    } catch (err) {
      console.log(`   ❌ Order placement failed on ${foundMarket.slug}: ${err.message}`);
    }
  }

  if (sheetRowsToLog.length > 0) {
    await sendToGoogleSheet(sheetRowsToLog);
  }
}

// 🔁 24/7 Loop: Har 1 minute me auto-check karega
async function startDaemon() {
  while (true) {
    try {
      await runAutoPlacer();
    } catch (e) {
      console.log("⚠️ Exception in loop, will retry in next cycle:", e.message);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

startDaemon();
