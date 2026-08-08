const http = require('http');
const PORT = process.env.PORT || 3002;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('All 5-Min Crypto Coins Tracker (HYPE Fixed) running 24/7!\n');
}).listen(PORT, () => {
  console.log(`Dummy server listening on port ${PORT}`);
});

const WebSocket = require("ws");
const axios = require("axios");

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

// 🔍 SMART MARKET FETCH (Tries both /events and /markets API endpoints)
async function fetchMarketData(slug) {
  try {
    const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout: 4000 });
    const event = res.data?.[0];
    if (event && event.markets && event.markets.length > 0) {
      const m = event.markets.find(m => m.active && !m.closed) || event.markets[0];
      if (m) return m;
    }
  } catch (e) {}

  try {
    const res = await axios.get(`https://gamma-api.polymarket.com/markets?slug=${slug}`, { timeout: 4000 });
    if (res.data && res.data.length > 0) {
      return res.data[0];
    }
  } catch (e) {}

  return null;
}

// 🧠 SMART TOKEN EXTRACTOR (Handles string, array, or token object differences)
function extractTokenIds(market) {
  if (!market) return null;
  let raw = market.clobTokenIds || market.clob_token_ids;

  if (!raw && market.tokens && Array.isArray(market.tokens)) {
    return market.tokens.map(t => String(t.token_id));
  }

  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) {}
  }

  if (Array.isArray(raw) && raw.length >= 2) {
    return [String(raw[0]), String(raw[1])];
  }

  return null;
}

async function sendToGoogleSheet(sheetTab, rowsToSend) {
  if (!rowsToSend || rowsToSend.length === 0) return;
  try {
    const res = await axios.post(GOOGLE_SHEET_WEBHOOK_URL, { 
      sheetName: sheetTab, 
      rows: rowsToSend 
    }, { timeout: 30000 });

    if (res.data?.status === "success") {
      console.log(`✅ [SHEET SUCCESS 5M] Summary log added to Tab: '${sheetTab}'`);
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
    console.log(`🚀 Engine Initialized for ${coinCfg.symbol} -> Tab: ${coinCfg.sheetTab}`);

    while (true) {
      try {
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

          const market = await fetchMarketData(liveSlug);

          if (market) {
            const tokenIds = extractTokenIds(market);

            if (!tokenIds || !tokenIds[0] || !tokenIds[1]) {
              console.log(`⚠️ [${coinCfg.symbol}] Token IDs not found for slot ${liveSlug}, retrying...`);
              await sleep(2000);
              continue;
            }

            activeSlot = currentSlot;

            if (currentWs) { try { currentWs.close(); } catch (e) {} }
            if (pollingInterval) { clearInterval(pollingInterval); }

            console.log(`📌 [5M ${coinCfg.symbol}] Connected Slot: ${liveSlug} (Tokens: ${tokenIds[0].substring(0, 8)}... / ${tokenIds[1].substring(0, 8)}...)`);

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
            }, 2000);

            const checkSlotEndInterval = setInterval(() => {
              const nowSec = Math.floor(Date.now() / 1000);
              if (nowSec >= slotEndSlot) {
                clearInterval(checkSlotEndInterval);

                const commonLeastPrice = Math.max(minYesPrice, minNoPrice);
                const centVal = Math.round(commonLeastPrice * 100);
                const finishTimeET = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" });

                console.log(`🏁 [SLOT FINISHED 5M - ${coinCfg.symbol}] ${liveSlug} -> Hit at least ${centVal}¢`);

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
        }
        await sleep(2000);
      } catch (err) {
        console.log(`⚠️ Exception for ${coinCfg.symbol}, auto-restarting in 4s...`);
        await sleep(4000);
      }
    }
  }

  runLoop();
}

TRACKED_COINS.forEach(startCoinEngine);
