import { describe, expect, test } from "bun:test";
import { makeTokenBucket } from "../../src/shared/rate-limit";

function fakeClock() {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
    advance: (ms: number) => { clock += ms; },
    get sleeps() { return sleeps; },
    get t() { return clock; },
  };
}

describe("makeTokenBucket", () => {
  test("first burst acquires return immediately (no sleep)", async () => {
    const c = fakeClock();
    const bucket = makeTokenBucket({ ratePerMinute: 60, burst: 3, now: c.now, sleep: c.sleep });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(c.sleeps).toEqual([]);
  });

  test("burst+1 acquire sleeps exactly 60_000/ratePerMinute ms", async () => {
    const c = fakeClock();
    // 60 req/min ⇒ 1000 ms per token.
    const bucket = makeTokenBucket({ ratePerMinute: 60, burst: 1, now: c.now, sleep: c.sleep });
    await bucket.acquire();           // immediate
    await bucket.acquire();           // sleeps 1000 ms
    expect(c.sleeps).toEqual([1000]);
  });

  test("N back-to-back calls at rate R take ~ (N - burst) * 60_000/R total ms", async () => {
    const c = fakeClock();
    // 30 req/min ⇒ 2000 ms per token. Burst 1. 5 acquires.
    const bucket = makeTokenBucket({ ratePerMinute: 30, burst: 1, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i++) await bucket.acquire();
    // After the first (burst), 4 acquires each need 2000 ms ⇒ 4 sleeps of 2000.
    expect(c.sleeps).toEqual([2000, 2000, 2000, 2000]);
    expect(c.t).toBe(8000);
  });

  test("FIFO: concurrent acquires resolve in call order", async () => {
    const c = fakeClock();
    const bucket = makeTokenBucket({ ratePerMinute: 60, burst: 1, now: c.now, sleep: c.sleep });
    const completion: number[] = [];
    const p1 = bucket.acquire().then(() => completion.push(1));
    const p2 = bucket.acquire().then(() => completion.push(2));
    const p3 = bucket.acquire().then(() => completion.push(3));
    await Promise.all([p1, p2, p3]);
    expect(completion).toEqual([1, 2, 3]);
  });

  test("default burst equals ratePerMinute", async () => {
    const c = fakeClock();
    const bucket = makeTokenBucket({ ratePerMinute: 5, now: c.now, sleep: c.sleep });
    // 5 acquires should all proceed without sleep.
    for (let i = 0; i < 5; i++) await bucket.acquire();
    expect(c.sleeps).toEqual([]);
    // The 6th should sleep 60_000 / 5 = 12_000 ms.
    await bucket.acquire();
    expect(c.sleeps).toEqual([12000]);
  });
});
