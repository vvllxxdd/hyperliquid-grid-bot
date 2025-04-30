# Hyperliquid Grid Bot

A production-grade grid trading bot for [Hyperliquid](https://hyperliquid.xyz) using Node.js and TypeScript.

## Features

- Dynamic grid strategy (buy/sell around the mid-price)
- Session-based PnL tracking
- Auto-grid shift on fills
- Safe stop and restart via terminal commands
- Periodic cleanup to prevent order stacking
- Docker and Docker Compose support

## Quickstart

### 1. Clone the repository

```bash
git clone https://github.com/vvllxxdd/hyperliquid-grid-bot.git
cd hyperliquid-grid-bot
```

### 2. Set up environment variables

Create a `.env` file from the provided template:

```bash
cp .env.example .env
```

Then edit `.env` with your config:

```env
PRIVATE_KEY=your-private-key
WALLET_ADDRESS=your-wallet-address
COIN=HYPE
SPOT_OR_PERP=PERP
SPACING=0.005
ORDER_SIZE=10
GRID_LEVELS=3
INTERVAL_MS=5000
```

## Running Locally

```bash
npm install
npx ts-node src/index.ts
```

## Docker Deployment

### Build and start the container

```bash
docker-compose up --build -d
```

### View container logs

```bash
docker-compose logs -f
```

### Stop and remove the container

```bash
docker-compose down
```

## Runtime Commands

These can be entered directly into the terminal while the bot is running:

| Command   | Description                        |
|-----------|------------------------------------|
| `stop`    | Cancels all open orders and exits  |
| `restart` | Cancels all orders and resets grid |
| `Ctrl+C`  | Safe exit with full cleanup        |

## Strategy Overview

- Places `GRID_LEVELS` buy and sell orders symmetrically around the mid-price.
- When a fill occurs, the opposite side of the market is shifted up/down to follow price action.
- Periodic cleanup ensures no order clustering or stale orders.
- PnL is tracked for each fill based on the grid spacing and order size.

## License

MIT License. Use at your own risk.
