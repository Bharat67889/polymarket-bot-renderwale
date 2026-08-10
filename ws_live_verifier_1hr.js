const http = require('http');
const PORT = process.env.PORT || 3001;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('1-Hour Dual Bot (BTC & ETH) is running 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server for 1-Hour Dual Bot listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

// 🎛️ DUAL COIN 1-HOUR CONFIGURATION
const TRACKED_1HR_COINS = [
  { symbol: "BTC", slugPrefix: "bitcoin-up-or-down", sheetTab: "Btc_1hr" },
  { symbol: "ETH", slugPrefix: "ethereum-up-or-down", sheetTab: "Eth_1hr" }
];

const CONFIG_TARGET_TIERS = [0.01];
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function get1HourSlug(prefix, slotUnix) {
  const dateObj = new Date(slotUnix * 1000);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  
  const nyDateStr = dateObj.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" });
  const [m, d, y] = nyDateStr.split("/").map(Number);
  const monthName = months[m - 1];

  const nyHourStr = dateObj.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
  let hour = parseInt(nyHourStr, 10);

  let ampm = "am";
  let displayHour = hour;

  if (hour === 0) { displayHour = 12; ampm = "am"; }
  else if (hour === 12) { displayHour = 12; ampm = "pm"; }
  else if (hour > 12) { displayHour = hour - 12; ampm = "pm"; }
  else { ampm = "am"; }

  return `${prefix}-${monthName}-${d}-${y}-${displayHour}${ampm}-et`;
}

async function sendBatchToGoogleSheet(sheetTab, batchToSend) {
  if (!batchToSend || batchToSend.length === 0) return;

  console.log(`\n⏳ [EVENT SYNC 1HR] Double Hit Found! Sending ${batchToSend.length} rows to Sheet Tab: '${sheetTab}'...`);

  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: sheetTab,
      rows: batchToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS 1HR] Added rows to '${sheetTab}' Sheet.\n`);
    } else {
      console.log(`⚠️ [SHEET SYNC WARN 1HR] Tab '${sheetTab}' response:`, res.data);
    }
  } catch (err) {
    console.log(`❌ [SHEET SYNC ERROR 1HR] Failed to send logs for 1-Hour event to '${sheetTab}'.`);
  }
}

function start1HourCoinEngine(coinCfg) {
  const slotSeconds = 3600;
  let activeSlot = 0;
  let currentWs = null;
  let pollingInterval = null;

  let slotLogsQueue = [];
  let doubleHitOccurred = false;

  async function runLoop() {
    console.log(`🚀 Starting 1HR Engine for ${coinCfg.symbol} -> Tab: ${coinCfg.sheetTab}`);

    while (true) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const currentSlot = now - (now % slotSeconds);
        const slotEndSlot = currentSlot + slotSeconds;

        if (currentSlot !== activeSlot) {
          const liveSlug = get1HourSlug(coinCfg.slugPrefix, currentSlot);
          
          const startDate = new Date(currentSlot * 1000);
          const endDate = new Date(slotEndSlot * 1000);

          const monthDay = startDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
          const startTimeStr = startDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
          const endTimeStr = endDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true });

          const bannerText = `LIVE SLOT (1HR - ${coinCfg.symbol}): ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

          const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`, { timeout: 5000 });
          const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed) || res.data?.[0]?.markets?.[0];

          if (market) {
            if (activeSlot !== 0) {
              if (doubleHitOccurred) {
                await sendBatchToGoogleSheet(coinCfg.sheetTab, slotLogsQueue);
              } else {
                console.log(`ℹ️ [SLOT ENDED 1HR - ${coinCfg.symbol}] No Double Hit in slot ${activeSlot}. Logs ignored.`);
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
            const yesAsset = tokenIds[0];
            const noAsset = tokenIds[1];

            let yes1cPrinted = false, yes5cPrinted = false, no1cPrinted = false, no5cPrinted = false;
            let yesHit = false, noHit = false;

            const queueLogForSheet = (timeET, timerStr, side, tier, priceVal) => {
              slotLogsQueue.push([timeET, liveSlug, timerStr, side, tier, priceVal]);
              console.log(`📝 [LOG BUFFERED 1HR - ${coinCfg.symbol}] Slot Queue count: ${slotLogsQueue.length}`);
            };

            const checkAndTriggerDoubleHit = (timeET, timerStr) => {
              if (yesHit && noHit && !doubleHitOccurred) {
                doubleHitOccurred = true;
                const ticks = "✅✅✅✅✅✅✅✅✅✅";
                console.log(`\n${ticks} 1-HOUR DOUBLE HIT DETECTED (${coinCfg.symbol})! ${ticks}\n`);
                slotLogsQueue.push([timeET, liveSlug, timerStr, `${ticks} BOTH SIDES HIT ${ticks}`, "DOUBLE_HIT", "ALERT"]);
              }
            };

            const processPriceUpdate = (assetId, price) => {
              if (isNaN(price) || price <= 0) return;

              const isYes = assetId === yesAsset;
              const isNo = assetId === noAsset;

              const nowSec = Math.floor(Date.now() / 1000);
              const secsLeft = Math.max(0, slotEndSlot - nowSec);
              const mins = String(Math.floor(secsLeft / 60)).padStart(2, "0");
              const secs = String(secsLeft % 60).padStart(2, "0");
              const timerStr = `${mins}m ${secs}s`;

              const currentTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

              if (CONFIG_TARGET_TIERS.includes(0.01) && price <= 0.01) {
                if (isYes && !yes1cPrinted) {
                  yes1cPrinted = true; yesHit = true;
                  console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR ${coinCfg.symbol} UP (YES) TOUCHED 1¢! ($${price.toFixed(3)})`);
                  queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "1¢", price.toFixed(3));
                  checkAndTriggerDoubleHit(currentTimeET, timerStr);
                }
                if (isNo && !no1cPrinted) {
                  no1cPrinted = true; noHit = true;
                  console.log(`🔥 [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR ${coinCfg.symbol} DOWN (NO) TOUCHED 1¢! ($${price.toFixed(3)})`);
                  queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "1¢", price.toFixed(3));
                  checkAndTriggerDoubleHit(currentTimeET, timerStr);
                }
              } 
              else if (CONFIG_TARGET_TIERS.includes(0.05) && price <= 0.05) {
                if (isYes && !yes5cPrinted) {
                  yes5cPrinted = true; yesHit = true;
                  console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR ${coinCfg.symbol} UP (YES) TOUCHED 5¢! ($${price.toFixed(3)})`);
                  queueLogForSheet(currentTimeET, timerStr, "UP (YES)", "5¢", price.toFixed(3));
                  checkAndTriggerDoubleHit(currentTimeET, timerStr);
                }
                if (isNo && !no5cPrinted) {
                  no5cPrinted = true; noHit = true;
                  console.log(`⚡ [${currentTimeET} ET] (Timer: ${timerStr}) -> 1HR ${coinCfg.symbol} DOWN (NO) TOUCHED 5¢! ($${price.toFixed(3)})`);
                  queueLogForSheet(currentTimeET, timerStr, "DOWN (NO)", "5¢", price.toFixed(3));
                  checkAndTriggerDoubleHit(currentTimeET, timerStr);
                }
              }
            };

            currentWs = new WebSocket(WS_URL);
            currentWs.on("open", () => {
              try { currentWs.send(JSON.stringify({ type: "market", assets_ids: [yesAsset, noAsset] })); } catch (e) {}
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
            }, 1500);

          } else {
            await sleep(2000);
            continue;
          }
        }
        await sleep(2000);
      } catch (err) {
        console.log(`⚠️ Exception in 1HR engine for ${coinCfg.symbol}, auto-restarting in 5s...`);
        await sleep(5000);
      }
    }
  }

  runLoop();
}

TRACKED_1HR_COINS.forEach(start1HourCoinEngine);
