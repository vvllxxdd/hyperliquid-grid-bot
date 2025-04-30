import sdk from "./hyperliquidClient";
import dotenv from "dotenv";
import { v4 as uuid } from "uuid";
dotenv.config();
sdk.connect();

const SPACING = parseFloat(process.env.SPACING!);
const HALF_SPACING = SPACING / 2;
const ORDER_SIZE = parseFloat(process.env.ORDER_SIZE!);
const GRID_LEVELS = parseInt(process.env.GRID_LEVELS!);
const COIN = process.env.COIN!;
const SPOT_OR_PERP = process.env.SPOT_OR_PERP!;
const SYMBOL = `${COIN}-${SPOT_OR_PERP}`;
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS!);
const USER_ADDRESS = process.env.WALLET_ADDRESS!;
const HEDGE_MODE = !!process.env.HEDGE_MODE;

type ActiveOrder = { id: any; price: number };

let sellOrders: ActiveOrder[] = [];
let buyOrders: ActiveOrder[] = [];
let sessionPnl = 0;
let running = true;

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
  size: number = ORDER_SIZE
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

async function initializeGrid() {
  const mid = await getMidPrice();

  const gridPromises = Array.from({ length: GRID_LEVELS }, (_, index) => {
    const level = index + 1;
    return Promise.all([
      placeOrder(mid * (1 + SPACING * level), false, ORDER_SIZE),
      placeOrder(mid * (1 - SPACING * level), true, ORDER_SIZE),
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
  // const filledOrder = sellOrders[filledIndex];

  // // Cancel ALL buy orders (opposite side)
  // await Promise.all(buyOrders.map((o) => cancelOrderWithTimeout(o.id)));
  // buyOrders = [];

  // // Cancel the filled sell order
  // await cancelOrderWithTimeout(filledOrder.id);
  // sellOrders.splice(filledIndex, 1);

  // // Rebuild sell side
  // const lastPrice =
  //   sellOrders[sellOrders.length - 1]?.price ?? (await getMidPrice());
  // const newSellOrder = await placeOrder(
  //   lastPrice * (1 + SPACING),
  //   false,
  //   ORDER_SIZE
  // );
  // if (newSellOrder) sellOrders.push(newSellOrder);
  // sellOrders = sellOrders.slice(-GRID_LEVELS);
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

  // Track profit
  const fillPrice = filledOrder.price;
  const profit = ORDER_SIZE * SPACING * fillPrice;
  sessionPnl += profit;
  console.log(`Sell fill profit: +${profit.toFixed(4)} USD`);
  console.log(`Session PnL: ${sessionPnl.toFixed(4)} USD`);

  // Rebuild buy grid shifted up
  await shiftBuyGrid(true);
}

async function handleBuyFill(filledIndex: number) {
  // const filledOrder = buyOrders[filledIndex];

  // // Cancel ALL sell orders (opposite side)
  // await Promise.all(sellOrders.map((o) => cancelOrderWithTimeout(o.id)));
  // sellOrders = [];

  // // Cancel the filled buy order
  // await cancelOrderWithTimeout(filledOrder.id);
  // buyOrders.splice(filledIndex, 1);

  // // Rebuild buy side
  // const lastPrice =
  //   buyOrders[buyOrders.length - 1]?.price ?? (await getMidPrice());
  // const newBuyOrder = await placeOrder(
  //   lastPrice * (1 - SPACING),
  //   true,
  //   ORDER_SIZE
  // );
  // if (newBuyOrder) buyOrders.push(newBuyOrder);
  // buyOrders = buyOrders.slice(-GRID_LEVELS);

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

  // Track profit
  const fillPrice = filledOrder.price;
  const profit = ORDER_SIZE * SPACING * fillPrice;
  sessionPnl += profit;
  console.log(`Buy fill profit: +${profit.toFixed(4)} USD`);
  console.log(`Session PnL: ${sessionPnl.toFixed(4)} USD`);

  // // Rebuild sell grid shifted down
  // await shiftSellGrid(false);
}

async function shiftBuyGrid(up: boolean) {
  await Promise.all(buyOrders.map((order) => cancelOrder(order.id)));
  buyOrders = [];

  const mid = await getMidPrice();
  const promises = [];

  for (let i = 1; i <= GRID_LEVELS; i++) {
    const price = mid * (1 - SPACING * i) * (up ? 1 + HALF_SPACING : 1);
    promises.push(placeOrder(price, true));
  }

  const results = await Promise.all(promises);

  for (const order of results) {
    if (order) buyOrders.push(order);
  }
}

async function shiftSellGrid(down: boolean) {
  await Promise.all(sellOrders.map((order) => cancelOrder(order.id)));
  sellOrders = [];

  const mid = await getMidPrice();
  const promises = [];

  for (let i = 1; i <= GRID_LEVELS; i++) {
    const price = mid * (1 + SPACING * i) * (down ? 1 - HALF_SPACING : 1);
    promises.push(placeOrder(price, false));
  }

  const results = await Promise.all(promises);

  for (const order of results) {
    if (order) sellOrders.push(order);
  }
}

async function periodicCleanup() {
  console.log("[CLEANUP] Running scheduled cleanup...");

  try {
    const openOrders = await sdk.info.getUserOpenOrders(USER_ADDRESS);

    if (openOrders?.length) {
      console.log(`[CLEANUP] Cancelling ${openOrders.length} open orders...`);
      await Promise.all(openOrders.map((o) => cancelOrderWithTimeout(o.oid)));
    }

    sellOrders = [];
    buyOrders = [];

    await initializeGrid();

    console.log("[CLEANUP] Grid reinitialized after cleanup.");
  } catch (err) {
    console.error("[CLEANUP] Error during cleanup:", err);
  }
}

async function main() {
  // Schedule cleanup every 10 minutes

  console.log("Starting Dynamic Grid Bot...");
  await initializeGrid();

  setInterval(periodicCleanup, 10 * 60 * 1000); // optional - comment if not needed

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
    console.log("sellOrders", JSON.stringify(sellOrders, null, 2));
    console.log("buyOrders", JSON.stringify(buyOrders, null, 2));
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
