import { describe, it, expect } from "bun:test";
import { defineConfig, type FinanceConfigInput, EmailParserSchema } from "./index";

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const input: FinanceConfigInput = { parsers: { simplefin: {} } };
    expect(defineConfig(input)).toBe(input);
  });

  it("parsers are optional — empty config is valid", () => {
    const result = defineConfig({});
    expect(result.parsers).toBeUndefined();
  });
});

describe("EmailParserSchema", () => {
  it("accepts valid Gmail + Ollama config", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: { backend: "gmail" },
      extractor: { backend: "ollama" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid IMAP + Anthropic config with required fields", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: {
        backend: "imap",
        host: "imap.example.com",
        username_env: "IMAP_USER",
        password_env: "IMAP_PASS",
      },
      extractor: {
        backend: "anthropic",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid Manual + OpenAI config", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: { backend: "manual", drop_directory: "/tmp/eml" },
      extractor: { backend: "openai" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid fetcher backend name", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: { backend: "carrier-pigeon" },
      extractor: { backend: "ollama" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects imap without required host field", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: {
        backend: "imap",
        username_env: "IMAP_USER",
        password_env: "IMAP_PASS",
        // host is missing
      },
      extractor: { backend: "ollama" },
    });
    expect(result.success).toBe(false);
  });

  it("fills in gmail defaults when only backend is given", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: { backend: "gmail" },
      extractor: { backend: "ollama" },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unexpected");
    const fetcher = result.data.fetcher;
    if (fetcher.backend !== "gmail") throw new Error("wrong backend");
    expect(fetcher.client_secret_path).toBe(".secrets/gmail_client.json");
    expect(fetcher.token_cache_path).toBe(".secrets/gmail_token.json");
  });

  it("fills in ollama defaults when only backend is given", () => {
    const result = EmailParserSchema.safeParse({
      fetcher: { backend: "gmail" },
      extractor: { backend: "ollama" },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unexpected");
    const extractor = result.data.extractor;
    if (extractor.backend !== "ollama") throw new Error("wrong backend");
    expect(extractor.url).toBe("http://localhost:11434/api/generate");
    expect(extractor.model).toBe("nuextract:3.8b");
  });
});
