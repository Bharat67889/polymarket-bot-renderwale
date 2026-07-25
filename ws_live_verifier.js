const WebSocket = require("ws");
const axios = require("axios");

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
// 🚨 APNA APPS SCRIPT WEBAPP URL YAHAN REPLACE KARO
const GOOGLE_SHEET_WEBHOOK_URL = "YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentWs = null;
let pollingInterval = null;

// 🧠 IN-MEMORY BATCH BUFFER
let pendingLogsQueue = [];

async function sendBatchToGoogleSheet() {
  if (pendingLogsQueue.length === 0) {
    console.log("📊 [HOURLY SYNC] No new logs to sync for this hour.");
    return;
  }

  // Current batch ko copy karke Queue clear kar do taaki repeat na ho
  const batchToSend = [...pendingLogsQueue];
  pendingLogsQueue = []; // Resetting buffer for next hour

  console.log(`\n⏳ [HOURLY SYNC] Syncing ${batchToSend.length} new log(s) to Google Sheets...`);

  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { rows: batchToSend }, { timeout: 10000 });
    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS] Added ${res.data.added} rows to Sheet. Queue reset for next batch.\n`);
    } else {
      console.log("⚠️ [SHEET SYNC WARN] Sheet response:", res.data);
    }
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR] Failed to send logs. Re-queuing logs for next sync cycle...");
    // Failure par data loss roakne ke liye logs ko wapas Queue me add kar do
    pendingLogsQueue = [...batchToSend, ...pendingLogsQueue];
  }
}

// ⏰ Automatic Hourly Interval (Har 1 Ghante (3,600,000 ms) me sync chalega)
setInterval(sendBatchToGoogleSheet, 60 * 60 * 1000);

async function trackContinuousMarkets() {
  console.log("==================================================");
  console.log("🚀 DUAL-ENGINE DIP TRACKER (+ HOURLY SHEET BATCH SYNC)");
  console.log("==================================================\n");

  let activeSlot = 0;

  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const currentSlot = now - (now % 300);
    const slotEndSlot = currentSlot + 300;

    if (currentSlot !== activeSlot) {
      const liveSlug = `btc-updown-5m-${currentSlot}`;
      
      const startDate = new Date(currentSlot * 1000);
      const endDate = new Date(slotEndSlot * 1000);

      const monthDay = startDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const startTimeStr = startDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      const endTimeStr = endDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true });

      const bannerText = `LIVE SLOT: ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

      try {
        const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`, { timeout: 5000 });
        const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);

        if (market) {
          activeSlot = currentSlot;

          if (currentWs) { try { currentWs.close(); } catch (e) {} }
          if (pollingInterval) { clearInterval(pollingInterval); }

          console.log(`\n==================================================`);
          console.log(`📌 ${bannerText}`);
          console.log(`==================================================`);

          // Header Row inside Sheet Queue
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
    // Array order: [Timestamp, Slot_Slug, Timer_Left, Side, Tier, Price]
    pendingLogsQueue.push([timeET, slug, timerStr, side, tier, priceVal]);
    console.log(`📝 [LOG BUFFERED] Total queued for next hourly sync: ${pendingLogsQueue.length}`);
  };

  const checkAndTriggerDoubleHit = (timeET, timerStr) => {
    if (yesHit && noHit && !doubleHitAlertPrinted) {
      doubleHitAlertPrinted = true;
      const ticks = "✅✅✅✅✅✅✅✅✅✅";
      console.log(`\n${ticks} DOUBLE HIT DETECTED! ${ticks}\n`);
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

    // 1 CENT TIER
    if (price <= 0.01) {
      if (isYes && !yes1cPrinted) {
        yes1cPrinted = true; yesHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> UP (YES) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no1cPrinted) {
        no1cPrinted = true; noHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> DOWN (NO) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
    } 
    // 5 CENT TIER
    else if (price <= 0.05) {
      if (isYes && !yes5cPrinted) {
        yes5cPrinted = true; yesHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> UP (YES) TOUCHED 5¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "5¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no5cPrinted) {
        no5cPrinted = true; noHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> DOWN (NO) TOUCHED 5¢! ($${price.toFixed(3)})`);
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