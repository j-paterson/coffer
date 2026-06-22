// Seedable PRNG and stochastic return samplers for the projection engine.
// Monte Carlo loop lives in the same module but is added in a later task.

export interface Random {
  next(): number; // uniform [0, 1)
}

// splitmix64: fast, well-mixed, BigInt-based. Good enough for MC paths.
export function makeRng(seed: bigint): Random {
  let state = seed;
  const MASK = (1n << 64n) - 1n;
  return {
    next(): number {
      state = (state + 0x9E3779B97F4A7C15n) & MASK;
      let z = state;
      z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
      z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
      z = (z ^ (z >> 31n)) & MASK;
      // Map high 53 bits to [0, 1).
      return Number(z >> 11n) / 2 ** 53;
    },
  };
}

// Box-Muller standard normal.
export function sampleNormal(rng: Random): number {
  let u1 = rng.next();
  if (u1 < 1e-300) u1 = 1e-300;
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Lognormal monthly total-return draw.
// Parameterized so that E[compound of 12 monthly returns] ≈ annualReturn.
// Uses the log-Euler correction: μ_m = ln(1 + μ)/12 − σ_m²/2.
export function sampleMonthlyLogReturn(
  rng: Random,
  annualReturn: number,
  annualVol: number,
): number {
  const sigmaM = annualVol / Math.sqrt(12);
  const muM = Math.log(1 + annualReturn) / 12 - (sigmaM * sigmaM) / 2;
  const z = sampleNormal(rng);
  return Math.exp(muM + sigmaM * z) - 1;
}
