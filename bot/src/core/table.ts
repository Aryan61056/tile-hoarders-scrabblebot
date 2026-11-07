// Cheap table-driven bidder: a base bid per letter, scaled by budget pacing and rack need.
// Fast enough to optimize directly against real recorded rival bids (sim/search.ts).

import { BidState } from "./ours.js";

export interface TableParams {
  T: number[]; // base bid per letter A..Z (coins)
  beta: number; // pacing exponent: scale *= (coins per remaining round / rho0)^beta
  rho0: number;
  vb: number; // vowel-balance strength (raise vowel bids when vowel-poor, cut consonants)
  vtarget: number; // target vowel fraction of the rack
  dup: number; // multiplier per copy of this letter already held
  lateSpend: number; // last N auctions: coins are worthless
  lateBoost: number;
  cap: number; // stop buying above this many tiles in the rack
  playLen: number;
  dumpAt: number;
  paceRate: number; // target tiles won per round
  paceW: number; // strength of the pace correction (0 = off)
  starveBal: number; // below this many coins, cash shorter words to refill (0 = off)
  starveLen: number; // shortest word cashed when starved
}

const VOWEL = new Set([0, 4, 8, 14, 20]);

export const DEFAULT_TABLE: TableParams = {
  T: [10.5, 16, 17, 13, 10.5, 19, 12.5, 20, 9.5, 28, 23, 10.5, 16, 10.5, 9.5, 16, 26, 10.5, 11.5, 9.5, 9.5, 17, 18, 30, 20, 36],
  beta: 0.8,
  rho0: 1.5,
  vb: 1.0,
  vtarget: 0.38,
  dup: 0.85,
  lateSpend: 8,
  lateBoost: 0.5,
  cap: 26,
  playLen: 7,
  dumpAt: 1,
  paceRate: 0.18,
  paceW: 0,
  starveBal: 0,
  starveLen: 4,
};

export function tableBid(p: TableParams, s: BidState): number {
  if (s.roundsLeft <= 1) return 0;
  let total = 0;
  let vowels = 0;
  for (let c = 0; c < 26; c++) {
    total += s.rack[c]!;
    if (VOWEL.has(c)) vowels += s.rack[c]!;
  }
  if (total >= p.cap) return 0;
  let b = p.T[s.letter]!;
  const frac = total > 0 ? vowels / total : p.vtarget;
  const need = p.vtarget - frac; // positive when vowel-poor
  const f = VOWEL.has(s.letter) ? 1 + p.vb * need : 1 - p.vb * need;
  b *= Math.min(2, Math.max(0.3, f));
  b *= Math.pow(p.dup, s.rack[s.letter]!);
  const rho = s.balance / Math.max(1, s.roundsLeft);
  b *= Math.min(3, Math.max(0.4, Math.pow(rho / p.rho0, p.beta)));
  if (p.paceW !== 0 && s.round !== undefined) {
    const target = p.paceRate * (s.round + 1) + 1;
    b *= Math.min(2.2, Math.max(0.6, Math.pow(target / ((s.won ?? 0) + 1), p.paceW)));
  }
  if (s.roundsLeft <= p.lateSpend) b *= 1 + p.lateBoost;
  return Math.min(Math.round(b), s.balance);
}
