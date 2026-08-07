const http = require('http');
const PORT = process.env.PORT || 3002;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('All 5-Min Crypto Coins Tracker running 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server for 5-Min Multi-Coin Bot listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

// 📊 ALL 7 COINS CONFIGURATION (From your screenshots)
const TRACKED_COINS = [
  { symbol: "BTC",  slugPrefix: "btc-updown-5m",  sheetTab: "Btc_5m" },
  { symbol: "ETH",  slugPrefix: "eth-updown-5m",  sheetTab: "Eth_5m" },
  { symbol: "SOL",  slugPrefix: "sol-updown-5m",  sheetTab: "Sol_5m" },
  { symbol: "XRP",  slugPrefix: "xrp-updown-5m",  sheetTab: "Xrp_5m" },
  { symbol: "DOGE", slugPrefix: "doge-updown-5m", sheetTab: "Doge_5m" },
  { symbol: "HYPE", slugPrefix: "hype-updown-5m", sheetTab: "Hype_5m" },
  { symbol: "BNB",  slugPrefix: "bnb-updown-5m",  sheetTab: "Bnb_5m" }
];

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyBAt2zPfkNG7oT_fQbV9OOSBoQ8wPjuUg6GdPt4sr3XLI4zylU0To1YMV4wCwkpp_6/exec";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendToGoogleSheet(sheetTab, rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;
  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: sheetTab, 
      rows: rowsToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SYNC SUCCESS 5M] Summary log added to Tab: '${sheetTab}'`);
    } else {
      console.log(`⚠️ [SHEET SYNC WARN 5M] Tab '${sheetTab}' Response:`, res.data);
    }
  } catch (err) {
    console.log(`❌ [SHEET ERROR 5M] Failed sending log to Tab: '${sheetTab}'`);
  }
}

function startCoinEngine(coinCfg) {
  const slotSeconds = 300;
  let activeSlot = 0;
  let currentWs = null;
  let pollingInterval = null;

  async function runLoop() {
    console.log(`🚀 Starting 5M Engine for ${coinCfg.symbol} -> Tab: ${coinCfg.sheetTab}`);

    while (true) {
      const now = Math.floor(Date.now() / 1000);
      const currentSlot = now - (now % slotSeconds);
      const slotEndSlot = currentSlot + slotSeconds;

      if (currentSlot !== activeSlot) {
        const liveSlug = `${coinCfg.slugPrefix}-${currentSlot}`;
        const startDate = new Date(currentSlot * 1000);
        const endDate = new Date(slotEndSlot * 1000);

        const monthDay = startDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
        const startTimeStr = startDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
        const endTimeStr = endDate.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true });

        const bannerText = `LIVE SLOT (5M - ${coinCfg.symbol}): ${monthDay}, ${startTimeStr}-${endTimeStr} ET | ${liveSlug}`;

        try {
          const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`, { timeout: 5000 });
          const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);

          if (market) {
            activeSlot = currentSlot;

            if (currentWs) { try { currentWs.close(); } catch (e) {} }
            if (pollingInterval) { clearInterval(pollingInterval); }

            console.log(`\n📌 [5M ${coinCfg.symbol}] Connected Slot: ${liveSlug}`);

            const tokenIds = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
            const yesAsset = tokenIds[0];
            const noAsset = tokenIds[1];

            let minYesPrice = 1.0;
            let minNoPrice = 1.0;

            const processPriceUpdate = (assetId, price) => {
              if (isNaN(price) || price <= 0) return;
              if (assetId === yesAsset && price < minYesPrice) minYesPrice = price;
              if (assetId === noAsset && price < minNoPrice) minNoPrice = price;
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
              if (nowSec >= slotEndSlot) {
                clearInterval(checkSlotEndInterval);

                const commonLeastPrice = Math.max(minYesPrice, minNoPrice);
                const centVal = Math.round(commonLeastPrice * 100);
                const finishTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

                console.log(`\n🏁 [SLOT FINISHED 5M - ${coinCfg.symbol}] ${liveSlug}`);
                console.log(`📊 UP Lowest: $${minYesPrice.toFixed(3)} | DOWN Lowest: $${minNoPrice.toFixed(3)}`);
                console.log(`🔥 BOTH SIDES HIT AT LEAST: ${centVal}¢ ($${commonLeastPrice.toFixed(3)})\n`);

                const rowsToSend = [
                  ["---", bannerText, "---", "---", "---", "---"],
                  [
                    finishTimeET,
                    liveSlug,
                    "SLOT_END",
                    `✅ BOTH SIDES HIT AT LEAST ${centVal}¢`,
                    `UP Min: $${minYesPrice.toFixed(3)} | DOWN Min: $${minNoPrice.toFixed(3)}`,
                    `$${commonLeastPrice.toFixed(3)}`
                  ]
                ];

                sendToGoogleSheet(coinCfg.sheetTab, rowsToSend);
              }
            }, 3000);

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

  runLoop();
}

// Start parallel tracking engines for all 7 coins
TRACKED_COINS.forEach(startCoinEngine);
