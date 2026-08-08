const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('15-Min 1 Cent Double Hit Bot running 24/7!\n');
}).listen(PORT);

const WebSocket = require("ws");
const axios = require("axios");

const CONFIG_ASSET = "BTC_15M";
const TARGET_PRICE = 0.01; // 1 Cent Target
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentWs = null, pollingInterval = null;

async function sendBatchToGoogleSheet(rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;
  try {
    await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { rows: rowsToSend }, { timeout: 30000 });
    console.log("✅ [SHEET SYNC SUCCESS] Double Hit logs successfully sent to Google Sheet!");
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR] Failed to send logs to Google Sheet.");
  }
}

async function trackContinuousMarkets() {
  let activeSlot = 0;
  const slotSeconds = 900;

  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const currentSlot = now - (now % slotSeconds);
    const slotEndSlot = currentSlot + slotSeconds;

    if (currentSlot !== activeSlot) {
      const liveSlug = `btc-updown-15m-${currentSlot}`;
      const startDate = new Date(currentSlot * 1000), endDate = new Date(slotEndSlot * 1000);

      const monthDay = startDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
      const startTimeStr = startDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
      const endTimeStr = endDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true });

      const bannerText = `LIVE SLOT (15M): ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

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

          const tokenIds = JSON.parse(market.clobTokenIds);
          startSlotEngine(tokenIds[0], tokenIds[1], slotEndSlot, liveSlug, bannerText);
        } else {
          await sleep(2000); continue;
        }
      } catch (err) {
        await sleep(3000); continue;
      }
    }
    await sleep(2000);
  }
}

function startSlotEngine(yesAsset, noAsset, slotEndTime, slug, bannerText) {
  let yesHit = false, noHit = false;
  let doubleHitOccurred = false;
  let slotLogsQueue = [];

  const queueLogForSheet = (timeET, timerStr, side, tier, priceVal) => {
    slotLogsQueue.push([timeET, slug, timerStr, side, tier, priceVal]);
  };

  const processPriceUpdate = (assetId, price) => {
    if (isNaN(price) || price <= 0) return;

    const currentTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const nowSec = Math.floor(Date.now() / 1000);
    const secsLeft = Math.max(0, slotEndTime - nowSec);
    const mins = String(Math.floor(secsLeft / 60)).padStart(2, "0");
    const secs = String(secsLeft % 60).padStart(2, "0");
    const timerStr = `${mins}m ${secs}s`;

    // Check 1 Cent ($0.01) Hit Conditions
    if (price <= TARGET_PRICE) {
      if (assetId === yesAsset && !yesHit) {
        yesHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> UP (YES) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "1¢", price.toFixed(3));
      }

      if (assetId === noAsset && !noHit) {
        noHit = true;
        console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> DOWN (NO) TOUCHED 1¢! ($${price.toFixed(3)})`);
        queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "1¢", price.toFixed(3));
      }

      // Check Double Hit Trigger
      if (yesHit && noHit && !doubleHitOccurred) {
        doubleHitOccurred = true;
        const ticks = "✅✅✅✅✅✅✅✅✅✅";
        console.log(`\n${ticks} 15-MIN DOUBLE HIT DETECTED AT 1¢! ${ticks}\n`);
        slotLogsQueue.push([currentTimeET, slug, timerStr, `${ticks} BOTH SIDES HIT 1¢ ${ticks}`, "DOUBLE_HIT", "ALERT"]);
      }
    }
  };

  currentWs = new WebSocket(WS_URL);
  currentWs.on("open", () => currentWs.send(JSON.stringify({ type: "market", assets_ids: [yesAsset, noAsset] })));

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

  // SLOT END MONITORING: Only send batch if DOUBLE HIT occurred
  const checkSlotEndInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= slotEndTime) {
      clearInterval(checkSlotEndInterval);

      if (doubleHitOccurred) {
        console.log(`\n🏁 [SLOT FINISHED] ${slug} -> Sending Double Hit Logs to Sheet...`);
        const finalBatch = [
          ["---", bannerText, "---", "---", "---", "---"],
          ...slotLogsQueue
        ];
        sendBatchToGoogleSheet(finalBatch);
      } else {
        console.log(`\nℹ️ [SLOT FINISHED] ${slug} -> No 1¢ Double Hit. Ignored (Nothing sent to Sheet).`);
      }
    }
  }, 3000);
}

trackContinuousMarkets();
