module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "./ws_live_verifier.js"
    },
    {
      name: "btc-1hr-bot",
      script: "./ws_live_verifier_1hr.js"
    },
    {
      name: "btc-5min-bot",
      script: "./ws_live_verifier_5min.js"
    }
  ]
};
