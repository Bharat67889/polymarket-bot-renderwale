require("dotenv").config();
const axios = require("axios");
const {
  ClobClient,
  Chain,
  Side,
  OrderType,
  AssetType
} = require("@polymarket/clob-client-v2");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const SIGNATURE_TYPE = 3;
const FUNDER_ADDRESS = "0x477dA82D73bc10f70Ad0978293B470042e3262cA";

// EXACT STRICT LIMIT PRICE (0.1 Cent Protection)
const EXACT_TARGET_PRICE = 0.001; // $0.001 = 0.1¢
const SHARES = 1;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runLast10SecSniper() {
  console.log("🚀 0.1¢ LAST-10-SECOND SNIPER STARTED...\n");

  // Auth setup
  let pk = process.env.POLY_PRIVATE_KEY.trim();
  if (!pk.startsWith("0x")) pk = "0x" + pk;

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    transport: http("https://polygon-rpc.com")
  });

  const authClient = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer: walletClient,
    creds: await (new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      signatureType: SIGNATURE_TYPE,
      funderAddress: FUNDER_ADDRESS
    })).createOrDeriveApiKey(),
    funderAddress: FUNDER_ADDRESS,
    signatureType: SIGNATURE_TYPE
  });

  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const currentSlot = now - (now % 300); // 5-min block start
    const slotEndTime = currentSlot + 300;  // 5-min block end
    const secondsRemaining = slotEndTime - now;

    // Aakhiri 10 seconds me enter karenge
    if (secondsRemaining <= 10 && secondsRemaining > 0) {
      console.log(`⏱️ Last 10 Seconds Reached! (${secondsRemaining}s remaining). Fetching market...`);

      const liveSlug = `btc-updown-5m-${currentSlot}`;
      try {
        const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${liveSlug}`);
        const market = res.data?.[0]?.markets?.find(m => m.active && !m.closed);

        if (market) {
          const tokenIds = JSON.parse(market.clobTokenIds);

          // YES & NO dono taraf strict limit order (0.1¢ Max Cap)
          for (let index = 0; index < 2; index++) {
            const sideName = index === 0 ? "YES" : "NO";
            
            try {
              const order = await authClient.createOrder(
                {
                  tokenID: tokenIds[index],
                  price: EXACT_TARGET_PRICE, // STRICT 0.001 CAP
                  side: Side.BUY,
                  size: SHARES,
                  feeRateBps: 0
                },
                { tickSize: "0.01" }
              );

              // FOK / IOC ensures instant match or immediate cancel if price > 0.001
              const orderRes = await authClient.postOrder(order, OrderType.FOK);

              if (orderRes.status === "matched") {
                console.log(`🎉 [JACKPOT MATCHED] ${sideName} 1 Share bought at EXACT 0.1¢!`);
              } else {
                console.log(`🛡️ [PROTECTED] ${sideName} not available at 0.1¢ (Status: ${orderRes.status || "unfilled"})`);
              }
            } catch (err) {
              console.log(`⚠️ ${sideName} Order Skipped: Price was higher than 0.1¢ limit.`);
            }
          }
        }
      } catch (e) {
        console.log("Market fetch error in last 10s:", e.message);
      }

      // Slot end hone tak rest
      console.log("Sleeping until next slot...\n");
      await sleep(secondsRemaining * 1000 + 1000);
    } else {
      // Last 10s aane tak har second tick check karega
      process.stdout.write(`\r⏳ Waiting for last 10s... (${secondsRemaining}s left in current slot)`);
      await sleep(1000);
    }
  }
}

runLast10SecSniper();