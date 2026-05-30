export interface TokenBucket {
  /** Acquire 1 token; resolves when one is available. FIFO. */
  acquire(): Promise<void>;
}

export interface MakeTokenBucketOpts {
  ratePerMinute: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function makeTokenBucket(opts: MakeTokenBucketOpts): TokenBucket {
  if (!(opts.ratePerMinute > 0)) {
    throw new Error("ratePerMinute must be positive");
  }
  const ratePerMs = opts.ratePerMinute / 60_000;
  const burst = opts.burst ?? opts.ratePerMinute;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  let tokens = burst;
  let last = now();
  let queue: Promise<void> = Promise.resolve();

  function refill() {
    const t = now();
    const elapsed = t - last;
    if (elapsed > 0) {
      tokens = Math.min(burst, tokens + elapsed * ratePerMs);
      last = t;
    }
  }

  async function take(): Promise<void> {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // Need (1 - tokens) more, at ratePerMs tokens/ms.
    const waitMs = Math.ceil((1 - tokens) / ratePerMs);
    await sleep(waitMs);
    refill();
    tokens -= 1;
  }

  return {
    acquire(): Promise<void> {
      const next = queue.then(take);
      // Swallow the value from `next` so failures in one acquirer
      // don't break ordering for subsequent ones.
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
