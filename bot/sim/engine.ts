// Match engine mirroring spacetimedb/src/game.ts (closeAuction, playWord):
// 98-tile bag, 6 bots x 5 start tiles, 100 coins, Vickrey (reserve 1), 68 auctions,
// word reward = base * length multiplier, score = sum of rewards.

import { BAG, Dict, VAL, rewardOf } from "./words.js";

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface BidView {
  letter: number; // 0..25
  round: number; // 0-based
  roundsLeft: number; // auctions remaining including this one
  balance: number;
  rack: Int8Array;
  me: number;
  scores: number[];
  balances: number[];
  unseen: Int8Array; // letters not yet seen by me (includes opponents' hidden tiles)
  priceSum: Float64Array; // public history of prices paid, per letter, this match
  priceN: Int32Array;
  rng: Rng;
  dict: Dict;
}
export interface WordView {
  balance: number;
  rack: Int8Array;
  me: number;
  auctionsLeft: number; // auctions still to be resolved after now (0 = no more play)
  scores: number[];
  balances: number[];
  rng: Rng;
  dict: Dict;
}
export interface Strategy {
  name: string;
  bid(v: BidView): number;
  words(v: WordView): number[]; // dictionary indices to play now
}

export interface PlayerResult {
  score: number;
  balance: number;
  tilesWon: number;
  paidTotal: number;
  words: string[];
  wordPlays: { len: number; reward: number }[];
  unplayed: number;
}
export interface MatchResult {
  players: PlayerResult[];
  prices: { letter: number; paid: number; top: number }[];
}

export const N_AUCTIONS_DEFAULT = 68;

export function runMatch(
  dict: Dict,
  strategies: Strategy[],
  rng: Rng,
  opts: { startRack?: number; startBalance?: number } = {},
): MatchResult {
  const N = strategies.length;
  const startRack = opts.startRack ?? 5;
  const startBalance = opts.startBalance ?? 100;
  // shuffled bag
  const bag: number[] = [];
  for (let c = 0; c < 26; c++) for (let k = 0; k < BAG[c]!; k++) bag.push(c);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  const racks = Array.from({ length: N }, () => new Int8Array(26));
  const startTiles = Array.from({ length: N }, () => new Int8Array(26));
  let pos = 0;
  for (let p = 0; p < N; p++)
    for (let k = 0; k < startRack; k++) {
      const c = bag[pos++]!;
      racks[p]![c]!++;
      startTiles[p]![c]!++;
    }
  const auctions = bag.slice(pos);
  const total = auctions.length;
  const balance = new Array<number>(N).fill(startBalance);
  const score = new Array<number>(N).fill(0);
  const res: PlayerResult[] = Array.from({ length: N }, () => ({
    score: 0,
    balance: 0,
    tilesWon: 0,
    paidTotal: 0,
    words: [],
    wordPlays: [],
    unplayed: 0,
  }));
  const seen = new Int8Array(26); // auctioned letters so far (public)
  const priceSum = new Float64Array(26);
  const priceN = new Int32Array(26);
  const prices: MatchResult["prices"] = [];

  const unseenFor = (p: number): Int8Array => {
    const u = new Int8Array(26);
    for (let c = 0; c < 26; c++) u[c] = BAG[c]! - seen[c]! - startTiles[p]![c]!;
    return u;
  };

  const playWords = (p: number, auctionsLeft: number) => {
    const strat = strategies[p]!;
    const idxs = strat.words({
      balance: balance[p]!,
      rack: racks[p]!,
      me: p,
      auctionsLeft,
      scores: score.slice(),
      balances: balance.slice(),
      rng,
      dict,
    });
    for (const i of idxs) {
      const o = i * 26;
      let ok = true;
      for (let c = 0; c < 26; c++) if (dict.counts[o + c]! > racks[p]![c]!) ok = false;
      if (!ok) continue;
      for (let c = 0; c < 26; c++) racks[p]![c]! -= dict.counts[o + c]!;
      const r = dict.rewards[i]!;
      score[p]! += r;
      balance[p]! += r;
      res[p]!.words.push(dict.words[i]!);
      res[p]!.wordPlays.push({ len: dict.lens[i]!, reward: r });
    }
  };

  for (let r = 0; r < total; r++) {
    const letter = auctions[r]!;
    seen[letter]!++; // the open letter is public, so it is no longer an unknown future draw
    const bids: { p: number; amt: number }[] = [];
    for (let p = 0; p < N; p++) {
      let amt = strategies[p]!.bid({
        letter,
        round: r,
        roundsLeft: total - r,
        balance: balance[p]!,
        rack: racks[p]!,
        me: p,
        scores: score.slice(),
        balances: balance.slice(),
        unseen: unseenFor(p),
        priceSum,
        priceN,
        rng,
        dict,
      });
      amt = Math.floor(amt);
      if (amt > 0 && amt <= balance[p]!) bids.push({ p, amt });
    }
    // random tie-break, then sort desc
    for (let i = bids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [bids[i], bids[j]] = [bids[j]!, bids[i]!];
    }
    bids.sort((a, b) => b.amt - a.amt);
    if (bids.length > 0) {
      const first = bids[0]!;
      const paid = bids.length > 1 ? bids[1]!.amt : Math.min(1, first.amt);
      balance[first.p]! -= paid;
      racks[first.p]![letter]!++;
      res[first.p]!.tilesWon++;
      res[first.p]!.paidTotal += paid;
      priceSum[letter]! += paid;
      priceN[letter]!++;
      prices.push({ letter, paid, top: first.amt });
    }
    const left = total - r - 1;
    if (left >= 1) for (let p = 0; p < N; p++) playWords(p, left);
  }
  for (let p = 0; p < N; p++) {
    res[p]!.score = score[p]!;
    res[p]!.balance = balance[p]!;
    let u = 0;
    for (let c = 0; c < 26; c++) u += racks[p]![c]!;
    res[p]!.unplayed = u;
  }
  return { players: res, prices };
}

export { VAL, rewardOf };
