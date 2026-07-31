const http = require('http');
// Port 3001 for 1-Hour script to avoid collision with 15m script
const PORT = process.env.PORT || 3001;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('1-Hour Bot is running alive 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server for 1-Hour Bot listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

// =========================================================================
// 🎛️ USER CONFIGURATION VARIABLES
// =========================================================================

// 1. COIN & TIMEFRAME FOR 1-HOUR BOT:
const CONFIG_ASSET = "BTC_1H";

// 2. PRICE TIERS TO DETECT:
const CONFIG_TARGET_TIERS = [0.01];

// 3. TARGET SHEET TAB NAME:
const TARGET_SHEET_NAME = "Btc_1hr";

// =========================================================================

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbxaG2uj8IvOJ2cFxK1-Dz6R9kXqQ_Pyk7ckU2NqUUSHGFuevM219L6-XWMO2vJl4dXm/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: 1-Hour Asset Config Parser
function getAssetConfig(assetKey) {
  const parts = assetKey.toUpperCase().split("_");
  const coin = parts[0].toLowerCase(); // btc
  const timeframe = parts[1]; // 1H

  // 1 Hour = 3600 seconds
  const slotSeconds = 3600;
  const slugTimeframe = "1h";

  return {
    coin,
    slotSeconds,
    slugPrefix: `${coin}-updown-${slugTimeframe}`
  };
}

let currentWs = null;
let pollingInterval = null;

// 🧠 IN-MEMORY BATCH BUFFER
let pendingLogsQueue = [];

async function sendBatchToGoogleSheet() {
  if (pendingLogsQueue.length === 0) {
    console.log("📊 [EVENT SYNC 1HR] No new logs to sync for previous slot.");
    return;
  }

  const batchToSend = [...pendingLogsQueue];
  pendingLogsQueue = []; 

  console.log(`\n⏳ [EVENT SYNC 1HR] Sending previous 1-Hour event data (${batchToSend.length} log(s)) to Google Sheets [Tab: ${TARGET_SHEET_NAME}]...`);

  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: TARGET_SHEET_NAME,
      rows: batchToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS 1HR] Added ${res.data.added} rows to '${TARGET_SHEET_NAME}' Sheet.\n`);
    } else {
      console.log("⚠️ [SHEET SYNC WARN 1HR] Sheet response:", res.data);
    }
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR 1HR] Failed to send logs for previous 1-Hour event.");
  }
}

async function trackContinuousMarkets() {
  const assetCfg = getAssetConfig(CONFIG_ASSET);

  console.log("==================================================");
  console.log(`🚀 DUAL-ENGINE DIP TRACKER [${CONFIG_ASSET}] -> Tab: ${TARGET_SHEET_NAME}`);
  console.log(`🎯 Active Target Tiers: ${CONFIG_TARGET_TIERS.map(t => `$${t}`).join(", ")}`);
  console.log("==================================================\n");

  let activeSlot = 0;

  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const currentSlot = now - (now % assetCfg.slotSeconds);
    const slotEndSlot = currentSlot + assetCfg.slotSeconds;

    if (currentSlot !== activeSlot) {
      const liveSlug = `${assetCfg.slugPrefix}-${currentSlot}`;
      
      const startDate = new Date(currentSlot * 1000);
      const endDate = new Date(slotEndSlot * 1000);

      const monthDay = startDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const startTimeStr = startDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      const endTimeStr = endDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true });

      const bannerText = `LIVE SLOT (1HR): ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

      try {
        const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`, { timeout: 5000 });
        const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);

        if (market) {
          if (activeSlot !== 0) {
            console.log(`\n🔄 [NEW 1HR EVENT DETECTED] Sending previous event logs before starting ${liveSlug}...`);
            await sendBatchToGoogleSheet();
          }

          activeSlot = currentSlot;

          if (currentWs) { try { currentWs.close(); } catch (e) {} }
          if (pollingInterval) { clearInterval(pollingInterval); }

          console.log(`\n==================================================`);
          console.log(`📌 ${bannerText}`);
          console.log(`==================================================`);

          pendingLogsQueue.push(["---", bannerText, "---", "---", "---", "---"]);

          const tokenIds = JSON.parse(market.clobTokenIds);
          startSlotEngine(tokenIds[0], tokenIds[1], slotEndSlot, liveSlug);
        } else {
          await sleep(2000);
          continue;
        }
      } catch (err) {
        await sleep(3000);
        continue;
      }
    }

    await sleep(2000);
  }
}

function startSlotEngine(yesAsset, noAsset, slotEndTime, slug) {
  let yes1cPrinted = false, yes5cPrinted = false, no1cPrinted = false, no5cPrinted = false;
  let yesHit = false, noHit = false, doubleHitAlertPrinted = false;

  const queueLogForSheet = (timeET, timerStr, side, tier, priceVal) => {
    pendingLogsQueue.push([timeET, slug, timerStr, side, tier, priceVal]);
    console.log(`📝 [LOG BUFFERED 1HR] Total queued for this event: ${pendingLogsQueue.length}`);
  };

  const checkAndTriggerDoubleHit = (timeET, timerStr) => {
    if (yesHit && noHit && !doubleHitAlertPrinted) {
      doubleHitAlertPrinted = true;
      const ticks = "✅✅✅✅✅✅✅✅✅✅";
      console.log(`\n${ticks} 1-HOUR DOUBLE HIT DETECTED! ${ticks}\n`);
      pendingLogsQueue.push([timeET, slug, timerStr, `${ticks} BOTH SIDES HIT ${ticks}`, "DOUBLE_HIT", "ALERT"]);
    }
  };

  const processPriceUpdate = (assetId, price) => {
    if (isNaN(price) || price <= 0) return;

    const isYes = assetId === yesAsset;
    const isNo = assetId === noAsset;

    const nowSec = Math.floor(Date.now() / 1000);
    const secsLeft = Math.max(0, slotEndTime - nowSec);
    const mins = String(Math.floor(secsLeft / 60)).padStart(2, "0");
    const secs = String(secsLeft % 60).padStart(2, "0");
    const timerStr = `${mins}m ${secs}s`;

    const currentTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // 1 CENT TIER DETECTOR
    if (CONFIG_TARGET_TIERS.includes(0.01) && price <= 0.01) {
      if (isYes && !yes1cPrinted) {
        yes1cPrinted = true; yesHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR UP (YES) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no1cPrinted) {
        no1cPrinted = true; noHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR DOWN (NO) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
    } 
    // 5 CENT TIER DETECTOR
    else if (CONFIG_TARGET_TIERS.includes(0.05) && price <= 0.05) {
      if (isYes && !yes5cPrinted) {
        yes5cPrinted = true; yesHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR UP (YES) TOUCHED 5¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "5¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no5cPrinted) {
        no5cPrinted = true; noHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR DOWN (NO) TOUCHED 5¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "5¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
    }
  };

  currentWs = new WebSocket(WS_URL);
  currentWs.on("open", () => {
    currentWs.send(JSON.stringify({ type: "market", assets_ids: [yesAsset, noAsset] }));
  });

  currentWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.price !== undefined && msg.asset_id) processPriceUpdate(msg.asset_id, parseFloat(msg.price));
      if (msg.last_trade_price !== undefined && msg.asset_id) processPriceUpdate(msg.asset_id, parseFloat(msg.last_trade_price));
      if (Array.isArray(msg.changes)) {
        for (const change of msg.changes) {
          if (change && change.asset_id && change.price !== undefined) processPriceUpdate(change.asset_id, parseFloat(change.price));
        }
      }
    } catch (e) {}
  });

  pollingInterval = setInterval(async () => {
    try {
      const [yesRes, noRes] = await Promise.all([
        axios.get(`https://clob.polymarket.com/price?token_id=${yesAsset}&side=buy`, { timeout: 1500 }),
        axios.get(`https://clob.polymarket.com/price?token_id=${noAsset}&side=buy`, { timeout: 1500 })
      ]);
      if (yesRes.data?.price) processPriceUpdate(yesAsset, parseFloat(yesRes.data.price));
      if (noRes.data?.price) processPriceUpdate(noAsset, parseFloat(noRes.data.price));
    } catch (e) {}
  }, 1000);
}

trackContinuousMarkets();
