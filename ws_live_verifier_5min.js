const http = require('http');
const PORT = process.env.PORT || 3002;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('5-Min Lowest Common Price Tracker running 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server for 5-Min Bot listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

const CONFIG_ASSET = "BTC_5M";
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

async function sendBatchToGoogleSheet(rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;

  console.log(`\n⏳ [EVENT SYNC 5M] Sending summary row to Sheet Tab: '${TARGET_SHEET_NAME}'...`);

  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: TARGET_SHEET_NAME,
      rows: rowsToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS 5M] Added summary log to '${TARGET_SHEET_NAME}' Sheet.\n`);
    } else {
      console.log("⚠️ [SHEET SYNC WARN 5M] Sheet response:", res.data);
    }
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR 5M] Failed to send summary log for 5-Min event.");
  }
}

async function trackContinuousMarkets() {
  const assetCfg = getAssetConfig(CONFIG_ASSET);

  console.log("==================================================");
  console.log(`🚀 LOWEST COMMON PRICE TRACKER [${CONFIG_ASSET}] -> Tab: ${TARGET_SHEET_NAME}`);
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
          activeSlot = currentSlot;

          if (currentWs) { try { currentWs.close(); } catch (e) {} }
          if (pollingInterval) { clearInterval(pollingInterval); }

          console.log(`\n==================================================`);
          console.log(`📌 ${bannerText}`);
          console.log(`==================================================`);

          const tokenIds = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
          startSlotEngine(tokenIds[0], tokenIds[1], slotEndSlot, liveSlug, bannerText);
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

function startSlotEngine(yesAsset, noAsset, slotEndTime, slug, bannerText) {
  let minYesPrice = 1.0;
  let minNoPrice = 1.0;

  const processPriceUpdate = (assetId, price) => {
    if (isNaN(price) || price <= 0) return;

    const currentTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (assetId === yesAsset && price < minYesPrice) {
      minYesPrice = price;
      console.log(`📉 [NEW LOW 5M - UP (YES)] $${minYesPrice.toFixed(3)} at ${currentTimeET}`);
    }

    if (assetId === noAsset && price < minNoPrice) {
      minNoPrice = price;
      console.log(`📉 [NEW LOW 5M - DOWN (NO)] $${minNoPrice.toFixed(3)} at ${currentTimeET}`);
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

  const checkSlotEndInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= slotEndTime) {
      clearInterval(checkSlotEndInterval);

      const commonLeastPrice = Math.max(minYesPrice, minNoPrice);
      const centVal = Math.round(commonLeastPrice * 100);

      const finishTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

      console.log(`\n🏁 [SLOT FINISHED 5M] ${slug}`);
      console.log(`📊 UP (YES) Lowest: $${minYesPrice.toFixed(3)} | DOWN (NO) Lowest: $${minNoPrice.toFixed(3)}`);
      console.log(`🔥 BOTH SIDES HIT AT LEAST: ${centVal}¢ ($${commonLeastPrice.toFixed(3)})\n`);

      const rowsToSend = [
        ["---", bannerText, "---", "---", "---", "---"],
        [
          finishTimeET,
          slug,
          "SLOT_END",
          `✅ BOTH SIDES HIT AT LEAST ${centVal}¢`,
          `UP Min: $${minYesPrice.toFixed(3)} | DOWN Min: $${minNoPrice.toFixed(3)}`,
          `$${commonLeastPrice.toFixed(3)}`
        ]
      ];

      sendBatchToGoogleSheet(rowsToSend);
    }
  }, 3000);
}

trackContinuousMarkets();
