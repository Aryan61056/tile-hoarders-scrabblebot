// Fast dictionary index and word-plan search for ScrabbleBot.
// Rules mirrored from clockworklabs/scrabblebot spacetimedb/src/letters.ts.

import * as fs from "node:fs";
import * as path from "node:path";

export const VAL = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]; // A..Z
export const BAG = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
]; // 98 tiles

export function rewardOf(len: number, base: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export class Dict {
  n: number;
  words: string[];
  counts: Uint8Array; // n * 26
  masks: Uint32Array;
  lens: Uint8Array;
  rewards: Uint16Array;
  byWord = new Map<string, number>();

  constructor(file: string) {
    const raw = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => /^[A-Z]{2,}$/.test(l));
    const scored = raw.map((w) => {
      let base = 0;
      for (let i = 0; i < w.length; i++) base += VAL[w.charCodeAt(i) - 65]!;
      return { w, r: rewardOf(w.length, base) };
    });
    scored.sort((a, b) => b.r - a.r || b.w.length - a.w.length);
    this.n = scored.length;
    this.words = scored.map((s) => s.w);
    this.counts = new Uint8Array(this.n * 26);
    this.masks = new Uint32Array(this.n);
    this.lens = new Uint8Array(this.n);
    this.rewards = new Uint16Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const w = this.words[i]!;
      let m = 0;
      for (let k = 0; k < w.length; k++) {
        const c = w.charCodeAt(k) - 65;
        this.counts[i * 26 + c]!++;
        m |= 1 << c;
      }
      this.masks[i] = m;
      this.lens[i] = w.length;
      this.rewards[i] = scored[i]!.r;
      this.byWord.set(w, i);
    }
  }

  // Indices of up to k best-reward words spellable from rack (reward descending).
  top(rack: Int8Array, k: number, out: number[]): number {
    let rm = 0;
    let total = 0;
    for (let c = 0; c < 26; c++) {
      if (rack[c]! > 0) {
        rm |= 1 << c;
        total += rack[c]!;
      }
    }
    out.length = 0;
    if (total < 2) return 0;
    const counts = this.counts;
    const masks = this.masks;
    const lens = this.lens;
    for (let i = 0; i < this.n; i++) {
      if (lens[i]! > total || (masks[i]! & ~rm) !== 0) continue;
      const o = i * 26;
      let ok = true;
      for (let c = 0; c < 26; c++) {
        if (counts[o + c]! > rack[c]!) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push(i);
        if (out.length >= k) break;
      }
    }
    return out.length;
  }

  remove(rack: Int8Array, i: number) {
    const o = i * 26;
    for (let c = 0; c < 26; c++) rack[c]! -= this.counts[o + c]!;
  }
  restore(rack: Int8Array, i: number) {
    const o = i * 26;
    for (let c = 0; c < 26; c++) rack[c]! += this.counts[o + c]!;
  }
}

const scratch: number[] = [];

// Total reward of a plan: greedy repeated best word.
export function greedyValue(d: Dict, rack: Int8Array): number {
  let total = 0;
  const used: number[] = [];
  for (;;) {
    if (d.top(rack, 1, scratch) === 0) break;
    const i = scratch[0]!;
    total += d.rewards[i]!;
    d.remove(rack, i);
    used.push(i);
  }
  for (const i of used) d.restore(rack, i);
  return total;
}

// Best partition value with `branch` alternatives tried for the first `depth` picks.
export function planValue(d: Dict, rack: Int8Array, branch = 4, depth = 2): number {
  if (depth <= 0) return greedyValue(d, rack);
  const cands: number[] = [];
  if (d.top(rack, branch, cands) === 0) return 0;
  let best = 0;
  for (const i of cands.slice()) {
    d.remove(rack, i);
    const v = d.rewards[i]! + planValue(d, rack, branch, depth - 1);
    d.restore(rack, i);
    if (v > best) best = v;
  }
  return best;
}

// The words of the best plan found (for actually playing them).
export function planWords(d: Dict, rack: Int8Array, branch = 4, depth = 2): number[] {
  const cands: number[] = [];
  if (d.top(rack, branch, cands) === 0) return [];
  let bestV = -1;
  let bestSeq: number[] = [];
  for (const i of cands.slice()) {
    d.remove(rack, i);
    const rest = depth > 1 ? planWords(d, rack, branch, depth - 1) : greedySeq(d, rack);
    d.restore(rack, i);
    let v = d.rewards[i]!;
    for (const j of rest) v += d.rewards[j]!;
    if (v > bestV) {
      bestV = v;
      bestSeq = [i, ...rest];
    }
  }
  return bestSeq;
}

function greedySeq(d: Dict, rack: Int8Array): number[] {
  const seq: number[] = [];
  const tmp: number[] = [];
  for (;;) {
    if (d.top(rack, 1, tmp) === 0) break;
    const i = tmp[0]!;
    seq.push(i);
    d.remove(rack, i);
  }
  for (const i of seq) d.restore(rack, i);
  return seq;
}
