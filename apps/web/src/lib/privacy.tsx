// Privacy mode: a single toggle that blurs all dollar amounts so the
// dashboard can be screenshotted and shared publicly without leaking real
// numbers. Pure client-side — never persisted to the DB, never sent to the
// API. Descriptions and account names are left alone.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { formatUsd } from "./format";
import type { Point } from "./LineChart";
import type { StackedSnapshot } from "./StackedSnapshotChart";
import type { Slice } from "./Donut";
import type { LabeledSlice } from "../components/LabeledDonut";

const STORAGE_KEY = "finance.privacyMode";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daySeed(seriesKey: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const str = today + ":" + seriesKey;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

export function privacyPoints(points: Point[], seriesKey: string): Point[] {
  if (points.length === 0) return [];
  const rand = mulberry32(daySeed(seriesKey));
  let value = 80_000 + rand() * 320_000;
  const stepInterval = 3 + Math.floor(rand() * 5);
  return points.map((p, i) => {
    if (i > 0 && i % stepInterval === 0) {
      value += 500 + rand() * 4_000;
    }
    return { ...p, y: value };
  });
}

export function privacySnapshots(
  snapshots: StackedSnapshot[],
  seriesKey: string,
): StackedSnapshot[] {
  if (snapshots.length === 0) return [];
  const rand = mulberry32(daySeed(seriesKey));
  const baseMap = new Map<string, { value: number; step: number }>();
  const getBase = (symbol: string) => {
    let entry = baseMap.get(symbol);
    if (!entry) {
      entry = { value: 2_000 + rand() * 30_000, step: 3 + Math.floor(rand() * 5) };
      baseMap.set(symbol, entry);
    }
    return entry;
  };
  return snapshots.map((s, si) => {
    const holdings = s.holdings.map((h) => {
      const base = getBase(h.symbol);
      if (si > 0 && si % base.step === 0) {
        base.value += 200 + rand() * 3_000;
      }
      return { symbol: h.symbol, value_usd: base.value };
    });
    const total = holdings.reduce((sum, h) => sum + h.value_usd, 0);
    return { as_of: s.as_of, total, holdings };
  });
}

export function privacySlices(slices: Slice[], seriesKey: string): Slice[] {
  if (slices.length === 0) return [];
  const rand = mulberry32(daySeed(seriesKey));
  return slices.map((s) => ({
    ...s,
    value: 100 + rand() * 900,
  }));
}

export function privacyLabeledSlices(
  slices: LabeledSlice[],
  seriesKey: string,
): LabeledSlice[] {
  if (slices.length === 0) return [];
  const rand = mulberry32(daySeed(seriesKey));
  return slices.map((s) => ({
    ...s,
    value: 100 + rand() * 900,
  }));
}

interface PrivacyCtx {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<PrivacyCtx>({
  enabled: false,
  setEnabled: () => {},
  toggle: () => {},
});

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  });

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
    }
  }, []);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);

  const value = useMemo(
    () => ({ enabled, setEnabled, toggle }),
    [enabled, setEnabled, toggle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrivacy(): PrivacyCtx {
  return useContext(Ctx);
}

export function usePrivateFormat() {
  const { enabled } = usePrivacy();

  const amount = useCallback(
    (n: number | null | undefined, opts?: { cents?: boolean }): string => {
      if (n == null) return "—";
      if (enabled) return "••••";
      return formatUsd(n, opts?.cents);
    },
    [enabled],
  );

  return { amount };
}

export function PrivacyBanner() {
  const { enabled, setEnabled } = usePrivacy();
  if (!enabled) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
      privacy mode on — dollar amounts are hidden.{" "}
      <button
        type="button"
        onClick={() => setEnabled(false)}
        className="underline hover:no-underline"
      >
        turn off
      </button>
    </div>
  );
}
