import { defineConfig } from "@coffer/config";
export default defineConfig({ parsers: { simplefin: { lookback_days: "not a number" as never } } });
