// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small, dependency-free seeded PRNG for deterministic synthetic data.
// SplitMix32 expands the seed; SFC32 (public-domain algorithm by Chris Doty-Humphrey)
// produces the stream. Not cryptographically secure - never use for secrets.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Standard normal sample (mean 0, sd 1). */
  normal(): number;
}

function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer in [0, 2^32-1], got ${seed}`);
  }
}

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function createRng(seed: number): Rng {
  assertSeed(seed);
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();

  const nextUint32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t >>> 0;
  };

  // Warm up so that similar seeds diverge quickly.
  for (let i = 0; i < 12; i++) nextUint32();

  let spare: number | undefined;

  const next = (): number => nextUint32() / 4294967296;

  // Marsaglia polar method: uses only log and sqrt (no trig) for reproducibility.
  const normal = (): number => {
    if (spare !== undefined) {
      const s = spare;
      spare = undefined;
      return s;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };

  return { next, normal };
}
