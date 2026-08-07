const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('15-Min Lowest Common Price Tracker running 24/7!\n');
}).listen(PORT);

const WebSocket = require("ws");
const axios = require("axios");

const CONFIG_ASSET = "BTC_15M";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentWs = null, pollingInterval = null;

async function sendBatchToGoogleSheet(rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;
  try {
    await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { rows: rowsToSend }, { timeout: 30000 });
    console.log("✅ [SHEET SYNC SUCCESS] Event summary log added to Google Sheet!");
  } catch (err) {
    console.log("❌ [SHEET SYNC ERROR] Failed to send log to Google Sheet.");
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
  // Track absolute minimum prices hit during this 15-min slot
  let minYesPrice = 1.0;
  let minNoPrice = 1.0;
  let yesHitTime = "N/A", noHitTime = "N/A";

  const processPriceUpdate = (assetId, price) => {
    if (isNaN(price) || price <= 0) return;

    const currentTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // Track lowest YES price
    if (assetId === yesAsset && price < minYesPrice) {
      minYesPrice = price;
      yesHitTime = currentTimeET;
      console.log(`📉 [NEW LOW - UP (YES)] $${minYesPrice.toFixed(3)} at ${currentTimeET}`);
    }

    // Track lowest NO price
    if (assetId === noAsset && price < minNoPrice) {
      minNoPrice = price;
      noHitTime = currentTimeET;
      console.log(`📉 [NEW LOW - DOWN (NO)] $${minNoPrice.toFixed(3)} at ${currentTimeET}`);
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

  // SLOT END MONITORING: Send calculated summary when 15-min slot finishes
  const checkSlotEndInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= slotEndTime) {
      clearInterval(checkSlotEndInterval);

      // Math.max gives the lowest common point where BOTH sides touched
      const commonLeastPrice = Math.max(minYesPrice, minNoPrice);
      const centVal = Math.round(commonLeastPrice * 100);

      const finishTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

      console.log(`\n🏁 [SLOT FINISHED] ${slug}`);
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
