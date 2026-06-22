// packages/shared/providers.ts
export type ProviderId =
  | "simplefin" | "zerion" | "alchemy" | "coinbase" | "defillama" | "geckoterminal";

export interface ProviderField {
  key: string;
  label: string;
  kind: "text" | "password" | "textarea";
  /** When set, the field value is written to provider_secrets under this name. */
  secretName?: string;
  /** When set, the field value is written into provider_connections.config_json. */
  configKey?: string;
  /** Value is a list (textarea split on newlines/commas → string[]). */
  multi?: boolean;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  needsAuth: boolean;
  fields: ProviderField[];
  special?: "simplefin";
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "simplefin", label: "SimpleFIN (banks & cards)", needsAuth: true, special: "simplefin",
    fields: [{ key: "token", label: "Setup token or Access URL", kind: "password", secretName: "SIMPLEFIN_ACCESS_URL" }],
  },
  {
    id: "zerion", label: "Zerion (crypto wallets)", needsAuth: true,
    fields: [
      { key: "api_key", label: "API key", kind: "password", secretName: "ZERION_API_KEY" },
      { key: "wallets", label: "Wallet addresses (one per line)", kind: "textarea", configKey: "wallets", multi: true },
    ],
  },
  {
    id: "alchemy", label: "Alchemy (on-chain history)", needsAuth: true,
    fields: [
      { key: "api_key", label: "API key", kind: "password", secretName: "ALCHEMY_API_KEY" },
      { key: "wallets", label: "Wallet addresses (one per line)", kind: "textarea", configKey: "wallets", multi: true },
    ],
  },
  {
    id: "coinbase", label: "Coinbase (exchange)", needsAuth: true,
    fields: [
      { key: "key_name", label: "API key name", kind: "text", secretName: "COINBASE_KEY_NAME" },
      { key: "private_key", label: "Private key (PEM)", kind: "textarea", secretName: "COINBASE_PRIVATE_KEY" },
    ],
  },
  { id: "defillama", label: "DefiLlama (prices)", needsAuth: false, fields: [] },
  { id: "geckoterminal", label: "GeckoTerminal (DEX prices)", needsAuth: false, fields: [] },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
export function getProvider(id: string): ProviderMeta | undefined {
  return BY_ID.get(id as ProviderId);
}
