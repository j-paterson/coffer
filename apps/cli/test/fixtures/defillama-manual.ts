import { defineConfig } from "@coffer/config";

export default defineConfig({
  parsers: {
    defillama: {
      targets: [
        { symbol: "USDC", chain: "ethereum", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", since: "2024-01-01" },
      ],
    },
  },
});
