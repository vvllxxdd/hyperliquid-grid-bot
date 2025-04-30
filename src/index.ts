import sdk from "./hyperliquidClient";
import dotenv from "dotenv";
import { CandleSnapshot } from "hyperliquid";
dotenv.config();
sdk.connect();

const SPREAD = parseFloat(process.env.SPREAD!);
const ORDER_SIZE = parseFloat(process.env.ORDER_SIZE!);
const GRID_LEVELS = parseInt(process.env.GRID_LEVELS!);
const COIN = process.env.COIN!;
const SPOT_OR_PERP = process.env.SPOT_OR_PERP!;
const SYMBOL = `${COIN}-${SPOT_OR_PERP}`;
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS!);
const USER_ADDRESS = process.env.WALLET_ADDRESS!;
const HEDGE_MODE = !!process.env.HEDGE_MODE;
const ATR_INTERVAL = process.env.ATR_INTERVAL || "1m";

type ActiveOrder = { id: any; price: number };

let sellOrders: ActiveOrder[] = [];
let buyOrders: ActiveOrder[] = [];

async function cancelOrderWithTimeout(orderId: any, timeoutMs = 5000) {
  return Promise.race([
    cancelOrder(orderId),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Cancel timeout for ${orderId}`)),
        timeoutMs
      )
    ),
  ]);
}

async function safeStop() {
  console.log("Cancelling all open orders...");

  try {
    await Promise.all(
      [...sellOrders, ...buyOrders].map((order) =>
        cancelOrderWithTimeout(order.id)
      )
    );
  } catch (err) {
    console.error("Error during safeStop:", err);
  }

  sellOrders = [];
  buyOrders = [];

  console.log("All orders cancelled (or timed out safely). Exiting bot.");

  // Force exit after small timeout to prevent Docker hang
  setTimeout(() => {
    console.log("Force exiting process...");
    process.exit(0);
  }, 2000); // 2 seconds max wait
}

async function safeRestart() {
  console.log("Restarting grid...");

  await safeStop();
  await initializeGrid();

  console.log("Grid restarted successfully.");
}

process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", async function (data) {
  const command = data.toString().trim().toLowerCase();

  if (command === "stop" || command === "exit") {
    console.log("Safe stop requested...");
    await safeStop();
    process.exit(0);
  }

  if (command === "restart") {
    console.log("Safe restart requested...");
    await safeRestart();
  }
});

process.on("SIGINT", async () => {
  console.log("\nCTRL+C detected, stopping safely...");
  await safeStop();
  process.exit(0);
});

function getFilledOrderIndex(
  activeOrders: ActiveOrder[],
  openIds: Set<number>
): number {
  return activeOrders.findIndex((order) => !openIds.has(order.id));
}

async function getMidPrice(): Promise<number> {
  const allMids = await sdk.info.getAllMids();
  const midPrice = parseFloat(allMids[SYMBOL]);

  console.log(`Mid price for ${SYMBOL}: ${midPrice}`);

  return midPrice;
}

async function placeOrder(
  price: number,
  isBuy: boolean,
  size: number = ORDER_SIZE || 1
) {
  return sdk.exchange
    .placeOrder({
      coin: SYMBOL,
      is_buy: isBuy,
      sz: size,
      limit_px: price.toFixed(3),
      order_type: { limit: { tif: "Gtc" } },
      reduce_only: HEDGE_MODE && isBuy,
    })
    .then((res) => {
      if (res.status == "err") {
        throw new Error(res.response);
      }

      console.log("placeOrder, res", JSON.stringify(res, null, 2));
      console.log(
        `Placed ${isBuy ? "BUY" : "SELL"} at ${price}, oid: ${
          res.response.data.statuses[0].resting.oid
        }`
      );
      return {
        id: res.response.data.statuses[0].resting.oid,
        price: price,
      };
    })
    .catch((err) => {
      console.error("Error placing order:", err);
    });
}

async function cancelOrder(orderId: any) {
  try {
    await sdk.exchange.cancelOrder({ coin: SYMBOL, o: orderId });
    console.log(`Cancelled order ${orderId}`);
  } catch (err) {
    console.error("Error cancelling order:", err);
  }
}

const getCandlesSnapshot = async () => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).getTime();
  const candles = await sdk.info.getCandleSnapshot(
    SYMBOL,
    ATR_INTERVAL,
    tenMinutesAgo,
    new Date().getTime()
  );

  console.log("candles", JSON.stringify(candles, null, 2));
  return candles;
};

const calculateAverageTrueRange = (candles: CandleSnapshot) => {
  // Calculate the True Range (TR) for each candle between the high and the low of the candle
  const trueRanges = candles.map((candle) => {
    // Extract the string high, low, and close prices from the candle as numbers
    const high = parseFloat(candle.h);
    const low = parseFloat(candle.l);
    const close = parseFloat(candle.c);

    // Calculate the True Range (TR)
    const tr = Math.max(
      high - low,
      Math.abs(high - close),
      Math.abs(low - close)
    );

    return tr;
  });

  // Calculate the Average True Range (ATR) over the last 14 candles
  const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
  console.log("ATR", atr);

  return atr / 100; // Convert ATR to a percentage
};

async function initializeGrid() {
  const mid = await getMidPrice();

  const candles = await getCandlesSnapshot();
  const atr = calculateAverageTrueRange(candles);

  const gridPromises = Array.from({ length: GRID_LEVELS }, (_, index) => {
    const level = index + 1;
    return Promise.all([
      placeOrder((mid + atr) * (1 + SPREAD * level), false, ORDER_SIZE * level),
      placeOrder((mid - atr) * (1 - SPREAD * level), true, ORDER_SIZE * level),
    ]);
  });

  const gridOrders = await Promise.all(gridPromises);

  gridOrders.forEach(([sellOrder, buyOrder]) => {
    if (sellOrder) sellOrders.push(sellOrder);
    if (buyOrder) buyOrders.push(buyOrder);
  });
}

async function checkFills() {
  const openOrders = await sdk.info
    .getUserOpenOrders(USER_ADDRESS)
    .then((res) => {
      return res.filter((o) => o.coin === SYMBOL);
    });

  if (!openOrders?.length) {
    console.log("No open orders found.");
    return;
  }

  const openOrderIds = new Set(openOrders.map((o) => o.oid));

  const sellIndex = getFilledOrderIndex(sellOrders, openOrderIds);
  if (sellIndex !== -1) {
    console.log(`Sell order filled at ${sellOrders[sellIndex].price}`);
    await handleSellFill(sellIndex);
    return;
  }

  const buyIndex = getFilledOrderIndex(buyOrders, openOrderIds);
  if (buyIndex !== -1) {
    console.log(`Buy order filled at ${buyOrders[buyIndex].price}`);
    await handleBuyFill(buyIndex);
    return;
  }
}

async function handleSellFill(filledIndex: number) {
  const filledOrder = sellOrders[filledIndex];

  console.log("[FILL] Sell order filled, resetting full grid...");

  const openOrders = await sdk.info.getUserOpenOrders(USER_ADDRESS);

  if (openOrders?.length) {
    await Promise.all(openOrders.map((o) => cancelOrderWithTimeout(o.oid)));
  }

  sellOrders = [];
  buyOrders = [];

  await initializeGrid();

  console.log("[FILL] Grid reset after sell fill.");
}

async function handleBuyFill(filledIndex: number) {
  const filledOrder = buyOrders[filledIndex];

  console.log("[FILL] Buy order filled, resetting full grid...");

  const openOrders = await sdk.info.getUserOpenOrders(USER_ADDRESS);

  if (openOrders?.length) {
    await Promise.all(openOrders.map((o) => cancelOrderWithTimeout(o.oid)));
  }

  sellOrders = [];
  buyOrders = [];

  await initializeGrid();

  console.log("[FILL] Grid reset after buy fill.");
}

async function main() {
  // Schedule cleanup every 10 minutes

  console.log("Starting Dynamic Grid Bot...");
  await initializeGrid();

  while (true) {
    try {
      await checkFills();

      // buyOrders + sellOrders length !== GRID_LEVELS * 2 cancel all orders and rebuild
      if (buyOrders.length + sellOrders.length !== GRID_LEVELS * 2) {
        console.log(
          `Grid mismatch detected: ${
            buyOrders.length + sellOrders.length
          } orders found. Rebuilding grid...`
        );
        await safeRestart();
      }
    } catch (err) {
      console.error("Error:", err);
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
