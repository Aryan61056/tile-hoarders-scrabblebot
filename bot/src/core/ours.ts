// Our strategy core. Pure functions shared by the live bot and the simulator,
// so what we test is what we run.

import { Dict, planValue, planWords } from "./words.js";

export interface OurParams {
  kappa: number; // coins bid per point of expected marginal value
  samples: number; // Monte Carlo samples for the future-tile completion
  pWin: number; // fraction of the remaining auctions we expect to win
  branch: number; // plan search breadth
  depth: number;
  playLen: number; // play words this long or longer as soon as available
  dumpAt: number; // dump the whole plan when this many auctions remain
  lateSpend: number; // in the last N auctions coins are worth nothing
  lateBoost: number;
  minBid: number; // bid at least this much on tiles with positive value
  beta: number; // budget-awareness: kappa *= (coins per remaining round / rho0)^beta
  rho0: number;
  starveBal: number; // below this many coins, cash shorter words to refill (0 = off)
  starveLen: number; // shortest word cashed when starved
  earlyFloor: number; // early game: bid at least earlyFloor x going price on common letters (0 = off)
  earlyRounds: number; // how many opening auctions the floor applies to
  floorMaxPrice: number; // only letters whose going price is at most this get the floor
  // Round-dependent valuation (0 = off). Linear ramp from the early value to the base value over `rampRounds` auctions.
  kappaEarly: number; // kappa used at round 0 (ramps to `kappa` at round rampRounds)
  pWinEarly: number; // pWin used at round 0 (ramps to `pWin`)
  rampRounds: number;
  // Word cashing (0 = off / legacy behaviour).
  playReward: number; // also play immediately any word worth at least this many points
  holdBal: number; // while balance is at least this, hold ALL words except the final dump; 0 = off
  starveRho: number; // starve threshold = max(starveBal, starveRho x auctionsLeft), capped at starveCap
  starveCap: number;
}

export const DEFAULT_OURS: OurParams = {
  kappa: 1.5, // replay seeds 5/11/17: +4.3/+5.0/+3.6 with holdBal 40 (base 1.15)
  samples: 64, // replay seeds 23/31: 8 -> 82.6/82.5, 32 -> 86.1/84.9, 64 -> 86.2 (seed 31); about 100 ms per bid live
  pWin: 0.2,
  branch: 3,
  depth: 1,
  playLen: 7,
  dumpAt: 1,
  lateSpend: 8,
  lateBoost: 0.6,
  minBid: 0,
  beta: 1,
  rho0: 1.5,
  starveBal: 10,
  starveLen: 4,
  earlyFloor: 0,
  earlyRounds: 25,
  floorMaxPrice: 15,
  kappaEarly: 0,
  pWinEarly: 0,
  rampRounds: 40,
  playReward: 0,
  holdBal: 40,
  starveRho: 0,
  starveCap: 40,
};

// Median price paid per letter in 17k real all-human matches (A..Z).
export const GOING_PRICE = [11, 17, 18, 14, 11, 20, 13, 21, 10, 29, 24, 11, 17, 11, 10, 17, 27, 11, 12, 10, 10, 18, 19, 31, 21, 38];

export interface BidState {
  letter: number; // 0..25
  roundsLeft: number; // auctions remaining, including this one (= bagTotal + 1)
  balance: number;
  rack: Int8Array;
  unseen: Int8Array; // letters not yet seen by us (includes opponents' hidden tiles)
  won?: number; // tiles we have won so far this match
  round?: number; // 0-based auction index
}

function sampleFuture(unseen: Int8Array, m: number, rng: () => number, out: Int8Array) {
  out.fill(0);
  const pool: number[] = [];
  for (let c = 0; c < 26; c++) for (let k = 0; k < unseen[c]!; k++) pool.push(c);
  const n = Math.min(m, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    out[pool[i]!]!++;
  }
}

const draw = new Int8Array(26);
const rackA = new Int8Array(26);

// Expected extra points from owning this tile, via Monte Carlo over future tiles.
export function marginalValue(
  p: OurParams,
  dict: Dict,
  s: BidState,
  rng: () => number,
  deadlineMs = Infinity,
): number {
  let pw = p.pWin;
  if (p.pWinEarly > 0 && s.round !== undefined && s.round < p.rampRounds) pw = p.pWinEarly + (p.pWin - p.pWinEarly) * (s.round / p.rampRounds);
  const future = Math.max(0, Math.round(pw * (s.roundsLeft - 1)));
  const S = future === 0 ? 1 : p.samples;
  const t0 = Date.now();
  let diff = 0;
  let done = 0;
  for (let i = 0; i < S; i++) {
    sampleFuture(s.unseen, future, rng, draw);
    for (let c = 0; c < 26; c++) rackA[c] = s.rack[c]! + draw[c]!;
    rackA[s.letter]!++;
    dict.beginScope(rackA); // one candidate list serves both plans (rack without / with the new tile)
    rackA[s.letter]!--;
    const vA = planValue(dict, rackA, p.branch, p.depth);
    rackA[s.letter]!++;
    const vB = planValue(dict, rackA, p.branch, p.depth);
    dict.endScope();
    diff += vB - vA;
    done++;
    if (Date.now() - t0 > deadlineMs) break;
  }
  return diff / done;
}

// How many coins to bid on the open auction (0 = skip).
export function ourBid(
  p: OurParams,
  dict: Dict,
  s: BidState,
  rng: () => number,
  deadlineMs = Infinity,
): number {
  // The last auction's tile can never be played: the match ends when it closes.
  if (s.roundsLeft <= 1) return 0;
  const marg = marginalValue(p, dict, s, rng, deadlineMs);
  // Opening floor: leaders buy from the first auction (coins recycle through words), so never sit it out.
  const floor =
    p.earlyFloor > 0 && s.round !== undefined && s.round < p.earlyRounds && GOING_PRICE[s.letter]! <= p.floorMaxPrice
      ? Math.round(p.earlyFloor * GOING_PRICE[s.letter]!)
      : 0;
  if (marg <= 0) return Math.min(Math.max(floor, p.minBid), s.balance);
  let k = p.kappa;
  if (p.kappaEarly > 0 && s.round !== undefined && s.round < p.rampRounds) k = p.kappaEarly + (p.kappa - p.kappaEarly) * (s.round / p.rampRounds);
  if (p.beta !== 0) {
    const rho = s.balance / Math.max(1, s.roundsLeft);
    k *= Math.min(3, Math.max(0.5, Math.pow(rho / p.rho0, p.beta)));
  }
  if (s.roundsLeft <= p.lateSpend) k *= 1 + p.lateBoost;
  return Math.min(Math.max(Math.round(marg * k), p.minBid, floor), s.balance);
}

// Dictionary indices of the words to play now. `auctionsLeft` counts the open auction.
// When coins run low mid-match, also cash the best shorter words so we can keep bidding.
export function ourWords(
  p: OurParams,
  dict: Dict,
  rack: Int8Array,
  auctionsLeft: number,
  balance = Infinity,
): number[] {
  const seq = planWords(dict, rack, p.branch + 1, p.depth + 1);
  if (auctionsLeft <= p.dumpAt) return seq;
  const out = seq.filter((i) => dict.lens[i]! >= p.playLen || (p.playReward > 0 && dict.rewards[i]! >= p.playReward));
  const thr = p.starveRho > 0 ? Math.max(p.starveBal, Math.min(p.starveCap, p.starveRho * auctionsLeft)) : p.starveBal;
  if (p.holdBal > 0 && balance >= p.holdBal) return [];
  if (thr > 0 && balance < thr) {
    const cash = seq
      .filter((i) => dict.lens[i]! >= p.starveLen && !out.includes(i))
      .sort((a, b) => dict.rewards[b]! - dict.rewards[a]!);
    let b = balance + out.reduce((t, i) => t + dict.rewards[i]!, 0);
    for (const i of cash) {
      if (b >= thr * 1.6) break;
      out.push(i);
      b += dict.rewards[i]!;
    }
  }
  return out;
}
