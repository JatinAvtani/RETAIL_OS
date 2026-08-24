/**
 * Deterministic PRNG for the mock corpus.
 *
 * `Math.random()` cannot be used anywhere in this generator: the corpus is gitignored and
 * regenerated on a fresh clone, so "same seed, byte-identical output" is the only thing that makes
 * the data reproducible for someone else. A non-deterministic generator would mean every clone got
 * a different corpus and no planted finding could be documented with an expected figure.
 *
 * mulberry32 — a small, fast, well-distributed 32-bit generator. Chosen over `crypto` (not
 * reproducible) and over adding a `seedrandom` dependency (this repo has a standing no-new-deps
 * bias, and 12 lines is cheaper than a package).
 */
export class Rng {
  private state: number;
  /** Kept so `derive` can mix it with a key — `state` advances and is not the seed after one draw. */
  private readonly seed: number;

  constructor(seed: number) {
    // >>> 0 keeps the state a genuine uint32 — a negative or float seed would silently produce a
    // different stream on a different engine.
    this.seed = seed >>> 0;
    this.state = seed >>> 0;
  }

  /**
   * An INDEPENDENT generator derived from this one's seed plus a stable string key.
   *
   * Why this exists: threading ONE sequential `Rng` through every day makes each day's output depend
   * on how many draws happened before it. That is reproducible only if the run performs the exact
   * same number of draws in the exact same order — and it does not, because the corpus anchors dates
   * to generation time, so a run that crosses midnight covers a different set of days and every
   * subsequent day's stream shifts. Two runs hours apart genuinely produced different receipts for
   * the SAME calendar day, which breaks the "byte-identical from a fresh clone" guarantee this whole
   * file exists to provide.
   *
   * Deriving a per-day stream from `(seed, key)` makes each day's data a pure function of its own
   * key, independent of iteration order or how many days precede it.
   */
  derive(key: string): Rng {
    // FNV-1a over the key, mixed with the seed. Cheap, stable across engines, and good enough
    // spread for stream separation — this picks a starting point, it is not a security hash.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return new Rng((h ^ this.seed) >>> 0);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max), rounded to `decimals`. Returned as a number for sizing decisions only — never used as money. */
  float(min: number, max: number, decimals = 2): number {
    const raw = min + this.next() * (max - min);
    const factor = 10 ** decimals;
    return Math.round(raw * factor) / factor;
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Fisher-Yates on a COPY — never mutates the caller's array, so call order can't leak between generators. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/**
 * The one seed the whole corpus derives from. Changing it regenerates a completely different (but
 * equally deterministic) corpus — every planted finding in findings/planted-findings.md is stated
 * against THIS seed, so changing it invalidates those documented figures.
 */
export const CORPUS_SEED = 20260823;
