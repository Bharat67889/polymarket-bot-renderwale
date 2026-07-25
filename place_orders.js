require("dotenv").config();
const axios = require("axios");
const {
  ClobClient,
  Chain,
  Side,
  OrderType
} = require("@polymarket/clob-client-v2");

const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

// IMPORTANT CHANGE: Signature type ko 2 ya 3 karo (Deposit Wallet Flow)
// 2 = POLY_GNOSIS_SAFE / Email-Magic Wallets
// 3 = POLY_1271 / Standard Browser Deposit Wallets
const SIGNATURE_TYPE = 3; 

// Aapka Deposit Wallet Address (Jo UI par Deposit/Profile me dikhta hai)
const FUNDER_ADDRESS = "0x477dA82D73bc10f70Ad0978293B470042e3262cA";

async function executeTestOrder() {
  console.log("🔍 Finding BTC 5m market...\n");

  const now = Math.floor(Date.now() / 1000);
  const currentSlot = now - (now % 300);

  let market = null;

  for (const slot of [
    currentSlot + 300,
    currentSlot + 600,
    currentSlot + 900
  ]) {
    const slug = `btc-updown-5m-${slot}`;
    console.log("Checking:", slug);

    try {
      const res = await axios.get(
        `https://gamma-api.polymarket.com/events?slug=${slug}`
      );

      if (res.data?.[0]?.markets) {
        const found = res.data[0].markets.find(
          (m) => m.active && !m.closed
        );

        if (found) {
          market = found;
          console.log("✅ FOUND:", res.data[0].title);
          break;
        }
      }
    } catch (e) {}
  }

  if (!market) {
    console.log("❌ No active market found");
    return;
  }

  const tokenID = JSON.parse(market.clobTokenIds)[0];
  console.log("📌 Question:", market.question);
  console.log("📌 Token ID:", tokenID);

  try {
    let pk = process.env.POLY_PRIVATE_KEY.trim();
    if (!pk.startsWith("0x")) pk = "0x" + pk;

    const account = privateKeyToAccount(pk);

    const walletClient = createWalletClient({
      account,
      transport: http("https://polygon-rpc.com")
    });

    console.log("Signer (EOA Address):", account.address);
    console.log("Funder (Deposit Wallet):", FUNDER_ADDRESS);

    // Initial API Client with Deposit Wallet Config
    const tempClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      signatureType: SIGNATURE_TYPE,
      funderAddress: FUNDER_ADDRESS
    });

    console.log("🔐 Deriving API credentials...");
    const creds = await tempClient.createOrDeriveApiKey();

    // Authenticated Client with Deposit Wallet
    const authClient = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: creds,
      funderAddress: FUNDER_ADDRESS,
      signatureType: SIGNATURE_TYPE
    });

    console.log("🚀 Creating & signing deposit order...");

   const buyPrice = parseFloat(process.env.BUY_PRICE) || 0.01;
const tradeAmount = parseFloat(process.env.TRADE_AMOUNT) || 5;

 const order = await authClient.createOrder(
  {
    tokenID: tokenID,
    price: buyPrice,
    side: Side.BUY,
    size: Number(tradeAmount), // explicit Number casting
    feeRateBps: 0
  },
  {
    tickSize: "0.01"
  }
);

    console.log("📡 Posting order to CLOB...");
    const result = await authClient.postOrder(order, OrderType.GTC);

    console.log("✅ Order Response:\n", JSON.stringify(result, null, 2));

  } catch (err) {
    console.log("❌ ERROR DETAILS:", err?.response?.data || err.message || err);
  }
}

executeTestOrder();