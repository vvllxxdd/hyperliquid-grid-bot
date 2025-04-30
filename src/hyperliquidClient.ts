import { Hyperliquid } from "hyperliquid";
import dotenv from "dotenv";

dotenv.config();

const sdk = new Hyperliquid({
  privateKey: process.env.PRIVATE_KEY!,
  //   walletAddress: process.env.WALLET_ADDRESS!,
  //   vaultAddress: process.env.VAULT_ADDRESS!,
  testnet: !process.env.MAINNET,
  enableWs: false,
});

sdk
  .ensureInitialized()
  .then(() => {
    console.log("SDK initialized");
  })
  .catch((err) => {
    console.error("Error initializing SDK:", err);
    process.exit(1);
  });

export default sdk;
