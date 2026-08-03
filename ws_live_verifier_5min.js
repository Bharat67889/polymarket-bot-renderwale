const http = require('http');
const PORT = process.env.PORT || 3002;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('5-Min Bot is running alive 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server for 5-Min Bot listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

const CONFIG_ASSET = "BTC_5M";
const CONFIG_TARGET_TIERS = [0.01];
const TARGET_SHEET_NAME = "Btc_5m";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getAssetConfig(assetKey) {
  return {
    coin: "btc",
    slotSeconds: 300,
    slugPrefix: "btc-updown-5m"
  };
}

let currentWs = null;
let pollingInterval = null;
let slotLogsQueue = [];
let doubleHitOccurred = false;

async function sendBatchToGoogleSheet(batchToSend) {
  if (batchToSend.length === 0) return;

  console.log(`\n⏳ [EVENT SYNC 5M] Double Hit Found! Sending ${batchToSend.length} rows to Sheet Tab: '${TARGET_SHEET_NAME}'...`);

  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: TARGET_SHEET_NAME,
      rows: batchToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS 5M] Added rows to '${TARGET_SHEET_NAME}' Sheet.\n`);
    } else {
      console.log("⚠️ [SHEET SYNC WARN 5M] Sheet response:", res.data);
    }
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR 5M] Failed to send logs for 5-Min event.");
  }
}

async function trackContinuousMarkets() {
  const assetCfg = getAssetConfig(CONFIG_ASSET);

  console.log("==================================================");
  console.log(`🚀 DUAL-ENGINE DIP TRACKER [${CONFIG_ASSET}] -> Tab: ${TARGET_SHEET_NAME}`);
  console.log(`🎯 Active Target Tiers: ${CONFIG_TARGET_TIERS.map(t => `$${t}`).join(", ")}`);
  console.log("🎯 FILTER MODE: ONLY DOUBLE HITS WILL BE SENT TO SHEET");
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

      const bannerText = `LIVE SLOT (5M): ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

      try {
        const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`, { timeout: 5000 });
        const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);

        if (market) {
          if (activeSlot !== 0) {
            if (doubleHitOccurred) {
              await sendBatchToGoogleSheet(slotLogsQueue);
            } else {
              console.log(`ℹ️ [SLOT ENDED 5M] No Double Hit in slot ${activeSlot}. Logs ignored.`);
            }
          }

          activeSlot = currentSlot;
          slotLogsQueue = [];
          doubleHitOccurred = false;

          if (currentWs) { try { currentWs.close(); } catch (e) {} }
          if (pollingInterval) { clearInterval(pollingInterval); }

          console.log(`\n==================================================`);
          console.log(`📌 ${bannerText}`);
          console.log(`==================================================`);

          slotLogsQueue.push(["---", bannerText, "---", "---", "---", "---"]);

          const tokenIds = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
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
  let yesHit = false, noHit = false;

  const queueLogForSheet = (timeET, timerStr, side, tier, priceVal) => {
    slotLogsQueue.push([timeET, slug, timerStr, side, tier, priceVal]);
    console.log(`📝 [LOG BUFFERED 5M] Slot Queue count: ${slotLogsQueue.length}`);
  };

  const checkAndTriggerDoubleHit = (timeET, timerStr) => {
    if (yesHit && noHit && !doubleHitOccurred) {
      doubleHitOccurred = true;
      const ticks = "✅✅✅✅✅✅✅✅✅✅";
      console.log(`\n${ticks} 5-MIN DOUBLE HIT DETECTED! ${ticks}\n`);
      slotLogsQueue.push([timeET, slug, timerStr, `${ticks} BOTH SIDES HIT ${ticks}`, "DOUBLE_HIT", "ALERT"]);
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

    if (CONFIG_TARGET_TIERS.includes(0.01) && price <= 0.01) {
      if (isYes && !yes1cPrinted) {
        yes1cPrinted = true; yesHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 5M UP (YES) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no1cPrinted) {
        no1cPrinted = true; noHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 5M DOWN (NO) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "1¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
    } 
    else if (CONFIG_TARGET_TIERS.includes(0.05) && price <= 0.05) {
      if (isYes && !yes5cPrinted) {
        yes5cPrinted = true; yesHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 5M UP (YES) TOUCHED 5¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "5¢", price.toFixed(3));
        checkAndTriggerDoubleHit(currentTimeET, timerStr);
      }
      if (isNo && !no5cPrinted) {
        no5cPrinted = true; noHit = true;
        console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 5M DOWN (NO) TOUCHED 5¢! ($${price.toFixed(3)})`);
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
