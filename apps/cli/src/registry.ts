import {
  simpleFinParser,
  coinbaseParser,
  alchemyParser,
  zerionParser,
  defiLlamaParser,
  geckoTerminalParser,
  type Parser,
} from "@coffer/parsers";
import type { ParserId } from "@coffer/config";

export type { ParserId } from "@coffer/config";

export const REGISTRY: Record<ParserId, Parser<unknown>> = {
  simplefin:     simpleFinParser     as Parser<unknown>,
  defillama:     defiLlamaParser     as Parser<unknown>,
  zerion:        zerionParser        as Parser<unknown>,
  alchemy:       alchemyParser       as Parser<unknown>,
  geckoterminal: geckoTerminalParser as Parser<unknown>,
  coinbase:      coinbaseParser      as Parser<unknown>,
};
