require("dotenv").config();
const axios = require("axios");
const {
  ClobClient,
  Chain,
  AssetType
} = require("@polymarket/clob-client-v2");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const SIGNATURE_TYPE = 3;
const FUNDER_ADDRESS = "0x477dA82D73bc10f70Ad0978293B470042e3262cA";

// ⚠️ BotFather se token tap karke yahan paste karo (Ensure no typo/spaces)
const TELEGRAM_BOT_TOKEN = "8840092611:AAG11_0hcWt5JiPSK_uV23v5rFY1ro_bpG8";
const TELEGRAM_CHAT_ID = "6973463545";

const BALANCE_SHEET_TAB = "Daily_Balance";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let lastLoggedDay = null;
let lastRecordedBalance = null;

async function getPolymarketBalance() {
  try {
    let pk = process.env.POLY_PRIVATE_KEY ? process.env.POLY_PRIVATE_KEY.trim() : "";
    if (!pk) {
      console.log("❌ Error: POLY_PRIVATE_KEY not found in .env file.");
      return null;
    }
    if (!pk.startsWith("0x")) pk = "0x" + pk;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      transport: http("https://polygon-bor-rpc.publicnode.com")
    });

    const initClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      signatureType: SIGNATURE_TYPE,
      funderAddress: FUNDER_ADDRESS
    });

    let apiCreds;
    try {
      apiCreds = await initClient.createOrDeriveApiKey();
      if (!apiCreds || !apiCreds.secret) apiCreds = await initClient.deriveApiKey();
    } catch (err) {
      try { apiCreds = await initClient.deriveApiKey(); } catch (e) { apiCreds = null; }
    }

    const authClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: apiCreds || undefined,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE
    });

    const balanceRes = await authClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const usdcBalance = parseFloat(balanceRes?.balance || 0) / 1e6;
    return usdcBalance;
  } catch (error) {
    console.log(`❌ Balance Fetch Failed: ${error.message || error}`);
    return null;
  }
}

async function sendTelegramAlert(message) {
  try {
    const cleanToken = TELEGRAM_BOT_TOKEN.trim();
    await axios.post(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID.trim(),
      text: message,
      parse_mode: "Markdown"
    });
    console.log("📱 [TELEGRAM SUCCESS] Notification sent to phone!");
  } catch (err) {
    console.log(`❌ [TELEGRAM ERROR ${err.response?.status || ''}] ${err.response?.data?.description || err.message}`);
  }
}

async function sendToGoogleSheet(rowsToSend) {
  try {
    await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: BALANCE_SHEET_TAB, 
      rows: rowsToSend 
    }, { timeout: 30000 });
    console.log(`✅ [SHEET SUCCESS] Daily Balance logged in '${BALANCE_SHEET_TAB}'`);
  } catch (err) {
    console.log(`❌ [SHEET ERROR] Failed sending log to '${BALANCE_SHEET_TAB}'`);
  }
}

async function logDailyBalanceSnapshot() {
  console.log("\n==================================================");
  console.log("💰 [BALANCE ENGINE] Fetching Live CLOB USDC Balance...");
  console.log("==================================================");

  const balance = await getPolymarketBalance();
  if (balance === null) return;

  const now = new Date();
  const dateET = now.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" });
  const timeET = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateIST = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "numeric" });
  const timeIST = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

  let diffText = "+$0.00";
  if (lastRecordedBalance !== null) {
    const diff = (balance - lastRecordedBalance).toFixed(2);
    diffText = diff >= 0 ? `+$${diff}` : `-$${Math.abs(diff)}`;
  }
  lastRecordedBalance = balance;

  // Single quote (' ) prevents Google Sheet formula parse error
  const sheetRow = [[`${dateET} (${timeET} ET)`, `$${balance.toFixed(2)}`, `'${diffText}`, `${dateIST} ${timeIST} IST`]];
  await sendToGoogleSheet(sheetRow);

  const teleMsg = `📊 *Polymarket Daily Balance Report*\n\n📅 Date: *${dateET}*\n⏰ Time: *${timeET} ET* (${timeIST} IST)\n💰 Balance: *$${balance.toFixed(2)} USDC*\n📈 24h P&L: *${diffText}*`;
  await sendTelegramAlert(teleMsg);
}

async function startBalanceDaemon() {
  console.log("🚀 Daily Balance Notifier Daemon Initialized...");
  await logDailyBalanceSnapshot();

  while (true) {
    try {
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-US", { timeZone: "America/New_York" });
      const currentHour = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });

      if (currentHour === "0" && lastLoggedDay !== todayStr) {
        lastLoggedDay = todayStr;
        await logDailyBalanceSnapshot();
      }
    } catch (e) {
      console.log("⚠️ Balance check loop error:", e.message);
    }
    await sleep(60 * 1000);
  }
}

startBalanceDaemon();
