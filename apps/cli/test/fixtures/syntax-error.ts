import { defineConfig } from "@coffer/config";

export default defineConfig({
  parsers: {
    // intentional syntax error below — unclosed object literal
    simplefin: { lookback_days:
