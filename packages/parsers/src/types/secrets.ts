export interface SecretResolver {
  get(name: string): Promise<string | null>;
}
