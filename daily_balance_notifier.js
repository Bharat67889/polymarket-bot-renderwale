require("dotenv").config();
const axios = require("axios");
const { createPublicClient, http, parseAbi } = require("viem");
const { polygon } = require("viem/chains");

const FUNDER_ADDRESS = "0x477dA82D73bc10f70Ad0978293B470042e3262cA";
const TELEGRAM_BOT_TOKEN = "8840092611:AAG11_0hcWt5JiPSK_uV23v5rFY1ro_bpG8";
const TELEGRAM_CHAT_ID = "6973463545";

const BALANCE_SHEET_TAB = "Daily_Balance";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

// Polygon Bridged USDC
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const publicClient = createPublicClient({ 
  chain: polygon, 
  transport: http("https://rpc.ankr.com/polygon") 
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let lastLoggedDay = null;
let lastRecordedBalance = null;

async function getUsdcBalance(walletAddress) {
  try {
    const balance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [walletAddress]
    });
    return Number(balance) / 1e6;
  } catch (e) {
    console.log("❌ Balance fetch error:", e.message);
    return null;
  }
}

async function sendTelegramAlert(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
    console.log("📱 [TELEGRAM SUCCESS] Notification sent to phone!");
  } catch (err) {
    console.log("❌ [TELEGRAM ERROR] Failed sending alert:", err.message);
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
  console.log("💰 [BALANCE ENGINE] Fetching Live USDC Balance & P&L...");
  console.log("==================================================");

  const balance = await getUsdcBalance(FUNDER_ADDRESS);
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

  // 1. Google Sheet Log
  const sheetRow = [[`${dateET} (${timeET} ET)`, `$${balance.toFixed(2)}`, diffText, `${dateIST} ${timeIST} IST`]];
  await sendToGoogleSheet(sheetRow);

  // 2. Telegram Alert
  const teleMsg = `📊 *Polymarket Daily Balance Report*\n\n📅 Date: *${dateET}*\n⏰ Time: *${timeET} ET* (${timeIST} IST)\n💰 Current Balance: *$${balance.toFixed(2)} USDC*\n📈 24h P&L: *${diffText}*`;
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
