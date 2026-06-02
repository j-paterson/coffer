import { z } from "zod";
import {
  SimpleFinConfig,
  DefiLlamaConfig,
  ZerionConfig,
  AlchemyConfig,
  GeckoTerminalConfig,
  CoinbaseConfig,
} from "@coffer/parsers";

export const PARSER_SCHEMAS = {
  simplefin:     SimpleFinConfig,
  defillama:     DefiLlamaConfig,
  zerion:        ZerionConfig,
  alchemy:       AlchemyConfig,
  geckoterminal: GeckoTerminalConfig,
  coinbase:      CoinbaseConfig,
} as const;

export type ParserId = keyof typeof PARSER_SCHEMAS;

// ---------------------------------------------------------------------------
// Email parser schema (TS-side source of truth for parsers.email)
// ---------------------------------------------------------------------------

export const EmailFetcherSchema = z.discriminatedUnion("backend", [
  z.object({
    backend: z.literal("gmail"),
    client_secret_path: z.string().default(".secrets/gmail_client.json"),
    token_cache_path: z.string().default(".secrets/gmail_token.json"),
    max_results: z.number().int().positive().optional(),
    query: z.string().optional(),
  }),
  z.object({
    backend: z.literal("imap"),
    host: z.string(),
    port: z.number().int().default(993),
    use_ssl: z.boolean().default(true),
    username_env: z.string(),
    password_env: z.string(),
    folder: z.string().default("INBOX"),
  }),
  z.object({
    backend: z.literal("manual"),
    drop_directory: z.string(),
  }),
]);

export const EmailExtractorSchema = z.discriminatedUnion("backend", [
  z.object({
    backend: z.literal("ollama"),
    url: z.string().default("http://localhost:11434/api/generate"),
    model: z.string().default("nuextract:3.8b"),
  }),
  z.object({
    backend: z.literal("anthropic"),
    api_key_env: z.string().default("ANTHROPIC_API_KEY"),
    model: z.string().default("claude-haiku-4-5-20251001"),
  }),
  z.object({
    backend: z.literal("openai"),
    api_key_env: z.string().default("OPENAI_API_KEY"),
    model: z.string().default("gpt-4o-mini"),
  }),
]);

export const EmailParserSchema = z.object({
  fetcher: EmailFetcherSchema,
  extractor: EmailExtractorSchema,
});

export type EmailParserInput = z.input<typeof EmailParserSchema>;
export type EmailParserOutput = z.output<typeof EmailParserSchema>;

// ---------------------------------------------------------------------------

export type FinanceConfigInput = {
  parsers?: {
    [K in ParserId]?: z.input<typeof PARSER_SCHEMAS[K]>;
  } & {
    email?: EmailParserInput;
  };
};

export function defineConfig(c: FinanceConfigInput): FinanceConfigInput {
  return c;
}
