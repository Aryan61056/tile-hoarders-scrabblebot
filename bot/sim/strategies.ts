import {
  BidView,
  Strategy,
  WordView,
  gauss,
} from "./engine.js";
import { VAL, planWords, Dict } from "./words.js";
import { OurParams, ourBid, ourWords } from "../src/core/ours.js";

const A = (ch: string) => ch.charCodeAt(0) - 65;

// Median price actually paid per letter in 17k all-human 6-bot matches (Cal Hacks data).
const LETTER_PRICE = (() => {
  const t: Record<string, number> = {
    Z: 38, X: 31, J: 29, Q: 27, K: 24, Y: 21, H: 21, F: 20, W: 19, M: 17, V: 18, C: 18,
    B: 17, P: 17, D: 14, G: 13, S: 12, L: 11, R: 11, E: 11, A: 11, I: 10, N: 11, O: 10,
    U: 10, T: 10,
  };
  const a = new Array<number>(26).fill(10);
  for (const [k, v] of Object.entries(t)) a[A(k)] = v;
  return a;
})();

function rackTotal(rack: Int8Array): number {
  let t = 0;
  for (let c = 0; c < 26; c++) t += rack[c]!;
  return t;
}

// ---------- calibrated field opponent ----------

export interface FieldParams {
  scale: number; // multiplier on the median paid price used as the base bid
  sigma: number; // per-bid log-normal noise
  botSigma: number; // per-bot persistent multiplier spread
  playLen: number; // play a word immediately once it has at least this many letters
  dumpAt: number; // dump the whole plan when this many auctions remain
}
export const DEFAULT_FIELD: FieldParams = {
  scale: 0.95,
  sigma: 0.3,
  botSigma: 0.15,
  playLen: 7,
  dumpAt: 1,
};

export function makeFieldBot(p: FieldParams, rng: () => number, name = "field"): Strategy {
  const mult = Math.exp(p.botSigma * gauss(rng));
  return {
    name,
    bid(v: BidView) {
      const base = LETTER_PRICE[v.letter]! * p.scale * mult * Math.exp(p.sigma * gauss(v.rng));
      return Math.min(Math.round(base), v.balance);
    },
    words(v: WordView) {
      if (v.auctionsLeft <= p.dumpAt) return planWords(v.dict, v.rack, 3, 1);
      if (rackTotal(v.rack) < p.playLen) return []; // cannot hold a long word yet
      const seq = planWords(v.dict, v.rack, 3, 1);
      return seq.filter((i) => v.dict.lens[i]! >= p.playLen);
    },
  };
}

// ---------- the upstream starter bot (baseline everyone starts from) ----------

export function makeStarterBot(): Strategy {
  return {
    name: "starter",
    bid(v: BidView) {
      const value = VAL[v.letter]!;
      const have = v.rack[v.letter]!;
      const want = have === 0 ? value + 2 : Math.max(1, value);
      return Math.min(want, v.balance);
    },
    words(v: WordView) {
      // plays the single longest spellable word whenever one exists
      const out: number[] = [];
      const best = planWords(v.dict, v.rack, 1, 1);
      // longest-first dictionary in the real starter; approximate by best-reward word
      if (best.length > 0) out.push(best[0]!);
      return out;
    },
  };
}

// ---------- our bot (shared core, identical to the live bot) ----------

export type { OurParams } from "../src/core/ours.js";
export { DEFAULT_OURS } from "../src/core/ours.js";

export function makeOurBot(p: OurParams, name = "ours"): Strategy {
  return {
    name,
    bid(v: BidView) {
      return ourBid(
        p,
        v.dict,
        { letter: v.letter, roundsLeft: v.roundsLeft, balance: v.balance, rack: v.rack, unseen: v.unseen, round: v.round },
        v.rng,
      );
    },
    words(v: WordView) {
      return ourWords(p, v.dict, v.rack, v.auctionsLeft, v.balance);
    },
  };
}

export type { Dict };
