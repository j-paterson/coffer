import type { SecretResolver } from "../types/secrets";

export class EnvSecretResolver implements SecretResolver {
  async get(name: string): Promise<string | null> {
    const v = process.env[name];
    return v === undefined ? null : v;
  }
}
