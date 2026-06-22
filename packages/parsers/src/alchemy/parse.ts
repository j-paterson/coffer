import type { Operation, PositionSnapshotDraft } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import type { AlchemyConfig } from "./config";
import {
  makeAlchemyRpc,
  getNativeBalance,
  getTokenBalances,
  getTokenMetadata,
  type AlchemyTokenBalance,
  type AlchemyTokenMetadata,
} from "./client";
import { CHAIN_INFO } from "./chains";
import {
  buildAccountDraft,
  buildNativePosition,
  buildTokenPosition,
  hexToQty,
} from "./mapper";

const SOURCE = "alchemy";

export async function* syncAlchemy(
  ctx: ParserContext<AlchemyConfig>,
): AsyncGenerator<Operation> {
  const c = ctx.config;

  const apiKey = await ctx.secrets.get(c.api_key_env);
  if (!apiKey) {
    yield {
      kind: "sync_warning",
      warning: { source: SOURCE, scope: "config", message: `${c.api_key_env} is not set` },
    };
    return;
  }

  if (c.wallets.length === 0) return;

  const asOf = ctx.now().toISOString().slice(0, 10);
  // In-process metadata cache: same-run dedup so wallet B holding USDC
  // doesn't re-hit ctx.cache after wallet A populated it.
  const metaInProcess = new Map<string, AlchemyTokenMetadata>();

  for (const addr of c.wallets) {
    const addrLower = addr.toLowerCase();

    for (const chain of c.chains) {
      const rpc = makeAlchemyRpc({ fetchJson: ctx.fetchJson, chain, apiKey });

      // 1) Native balance
      let nativeHex: string | null = null;
      try {
        nativeHex = await getNativeBalance(rpc, addrLower);
      } catch (err) {
        yield warning("native_balance_failed", chain, addrLower, err);
        // continue — token balances may still succeed
      }

      // 2) Token balances
      let tokens: AlchemyTokenBalance[] = [];
      try {
        const res = await getTokenBalances(rpc, addrLower);
        tokens = (res.tokenBalances ?? []).filter((t) =>
          typeof t.contractAddress === "string"
          && typeof t.tokenBalance === "string"
          && t.tokenBalance !== "0x"
          && t.tokenBalance !== "0x0",
        );
      } catch (err) {
        yield warning("token_balances_failed", chain, addrLower, err);
        tokens = [];
      }

      // 3) Build positions list (resolves metadata lazily, caches it)
      const positions: PositionSnapshotDraft[] = [];
      const accountDraft = buildAccountDraft(chain, addrLower);
      const nativeDecimals = CHAIN_INFO[chain].nativeDecimals;
      const nativeQty = nativeHex !== null ? hexToQty(nativeHex, nativeDecimals) : 0;

      if (nativeQty > 0) {
        positions.push(buildNativePosition({
          chain, accountId: accountDraft.id, qty: nativeQty, asOf,
        }));
      }

      for (const t of tokens) {
        const contractLower = t.contractAddress.toLowerCase();
        const ipKey = `${chain}:${contractLower}`;
        const cacheKey = `alchemy:metadata:${chain}:${contractLower}`;

        let md = metaInProcess.get(ipKey);
        if (md === undefined) {
          const cached = await ctx.cache.get<AlchemyTokenMetadata>(cacheKey);
          md = cached ?? undefined;
        }
        if (md === undefined) {
          try {
            md = await getTokenMetadata(rpc, contractLower);
            await ctx.cache.set(cacheKey, md, c.metadata_cache_ttl_seconds);
          } catch (err) {
            yield warning("token_metadata_failed", chain, addrLower, err, { contract: contractLower });
            continue;
          }
        }
        metaInProcess.set(ipKey, md);

        const pos = buildTokenPosition({
          chain,
          accountId: accountDraft.id,
          contract: contractLower,
          rawHex: t.tokenBalance!,
          metadata: md,
          asOf,
        });
        if (pos !== null) positions.push(pos);
      }

      // Emit only if we have at least one position (matches Python).
      if (positions.length === 0) continue;

      yield { kind: "account_discovery", draft: accountDraft };
      for (const p of positions) yield { kind: "position_snapshot", draft: p };
    }
  }
}

function warning(
  scope: string,
  chain: string,
  addr: string,
  err: unknown,
  detail: Record<string, unknown> = {},
): Operation {
  return {
    kind: "sync_warning",
    warning: {
      source: SOURCE,
      scope,
      message: `${scope} for ${addr}/${chain}: ${(err as Error).message}`,
      detail: { addr, chain, ...detail },
    },
  };
}
