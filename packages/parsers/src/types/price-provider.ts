export interface PriceLookup {
  price_usd: number;
  /** YYYY-MM-DD; may differ from requested date if nearest-neighbor fired. */
  as_of: string;
  /** Source label, e.g., "defillama", "coingecko", "test". */
  source: string;
}

export interface PriceProviderArgs {
  symbol: string;
  chain?: string;
  contract_address?: string;
  as_of: string; // YYYY-MM-DD
}

export interface PriceProvider {
  getPrice(args: PriceProviderArgs): Promise<PriceLookup | null>;
}

export class NullPriceProvider implements PriceProvider {
  async getPrice(_args: PriceProviderArgs): Promise<null> {
    return null;
  }
}

export class MapPriceProvider implements PriceProvider {
  constructor(private readonly seed: Record<string, number>) {}
  async getPrice(args: PriceProviderArgs): Promise<PriceLookup | null> {
    const key = `${args.symbol}:${args.as_of}`;
    const px = this.seed[key];
    return px == null ? null : { price_usd: px, as_of: args.as_of, source: "test" };
  }
}
