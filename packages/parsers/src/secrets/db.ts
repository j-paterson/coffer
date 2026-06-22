import type { Database } from "bun:sqlite";
import type { SecretResolver } from "../types/secrets";

/** Resolves secrets from the provider_secrets table, falling back to
 *  another resolver (typically EnvSecretResolver) when the DB has no
 *  non-empty value. */
export class DbSecretResolver implements SecretResolver {
  constructor(
    private readonly db: Database,
    private readonly fallback?: SecretResolver,
  ) {}

  async get(name: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM provider_secrets WHERE name = ?")
      .get(name) as { value: string } | undefined;
    if (row && row.value !== "") return row.value;
    return this.fallback ? this.fallback.get(name) : null;
  }
}
