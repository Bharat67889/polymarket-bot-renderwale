require("dotenv").config();
const axios = require("axios");

async function scanStep1() {
  console.log("🔍 [STEP 1] Scanning LIVE & ABSOLUTE FARTHEST markets...\n");

  const now = Math.floor(Date.now() / 1000);
  const currentSlot = now - (now % 300);

  let liveMarket = null;
  let farthestMarket = null;

  // 1. Get LIVE / CURRENT Market (Slot 0)
  const currentSlug = `btc-updown-5m-${currentSlot}`;
  try {
    const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${currentSlug}`);
    if (res.data?.[0]?.markets) {
      const found = res.data[0].markets.find(m => m.active || !m.closed);
      if (found) {
        const d = new Date(currentSlot * 1000);
        liveMarket = {
          title: res.data[0].title,
          slug: currentSlug,
          timeET: d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }),
          timeIST: d.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }),
          tokens: JSON.parse(found.clobTokenIds)
        };
      }
    }
  } catch (e) {}

  // 2. Scan to find the ABSOLUTE FARTHEST market
  let slotIndex = 1;
  let emptyCount = 0;

  while (emptyCount < 3) {
    const slot = currentSlot + (slotIndex * 300);
    const slug = `btc-updown-5m-${slot}`;

    try {
      const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      if (res.data?.[0]?.markets) {
        const found = res.data[0].markets.find(m => m.active && !m.closed);
        if (found) {
          const d = new Date(slot * 1000);
          farthestMarket = {
            slotIndex,
            slot,
            slug,
            title: res.data[0].title,
            timeET: d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }),
            timeIST: d.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }),
            tokens: JSON.parse(found.clobTokenIds)
          };
          emptyCount = 0; // Reset consecutive empty count
        } else {
          emptyCount++;
        }
      } else {
        emptyCount++;
      }
    } catch (e) {
      emptyCount++;
    }
    slotIndex++;
  }

  // 3. Print Clean Verification Report
  console.log("==================================================");
  console.log("🟢 1. LIVE / CURRENT MARKET (Running Right Now)");
  if (liveMarket) {
    console.log("   Title   :", liveMarket.title);
    console.log("   Slug    :", liveMarket.slug);
    console.log("   Time ET :", liveMarket.timeET);
    console.log("   Time IST:", liveMarket.timeIST);
    console.log("   YES Token:", liveMarket.tokens[0]);
    console.log("   NO Token :", liveMarket.tokens[1]);
  } else {
    console.log("   ❌ Live market transition in progress / Not fetched.");
  }

  console.log("--------------------------------------------------");
  console.log("🎯 2. ABSOLUTE FARTHEST MARKET (Newest Available)");
  if (farthestMarket) {
    console.log("   Title   :", farthestMarket.title);
    console.log("   Slug    :", farthestMarket.slug);
    console.log("   Time ET :", farthestMarket.timeET);
    console.log("   Time IST:", farthestMarket.timeIST);
    console.log("   Slot Index : +", farthestMarket.slotIndex, `(~${(farthestMarket.slotIndex * 5 / 60).toFixed(1)} Hours ahead)`);
    console.log("   YES Token:", farthestMarket.tokens[0]);
    console.log("   NO Token :", farthestMarket.tokens[1]);
  } else {
    console.log("   ❌ Farthest market not found.");
  }
  console.log("==================================================\n");
}

scanStep1();