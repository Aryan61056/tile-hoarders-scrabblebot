// Counterfactual replay on real recorded matches (bot/data/replay.jsonl, built by tools/make_replay.py).
//
// For a seat X in a recorded match: the highest rival bid on each auction is `paid` if X won it,
// else `top` (both recorded). Our bot takes X's seat: it wins an auction if its bid beats that
// highest rival bid, and pays it (Vickrey). Rivals' tiles, racks and later bids are not re-simulated,
// so this ignores rivals adapting to what we take; our own score only depends on our own tiles,
// so it is exact for us given the rivals' recorded bids.
//
// Usage: npx tsx sim/replay.ts '<json {label: params}>' [matches] [seed] [recent|all|tournament]

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface Rec {
  id: number;
  tournament: boolean;
  letters: string;
  top: number[];
  paid: number[];
  winner: string[];
  bots: string[];
  scores: number[];
}
export interface RAgg {
  n: number;
  score: number;
  scoreSq: number;
  place: number;
  wins: number;
  last: number;
  tiles: number;
  paid: number;
  words: number;
  n7: number;
  endbal: number;
  unpl: number;
  actual: number; // actual score of the bot we replaced
  firstWin: number; // round index (0-based) of first tile won
  noWinBy20: number; // matches where we won nothing in the first 20 rounds
}
const zero = (): RAgg => ({ n: 0, score: 0, scoreSq: 0, place: 0, wins: 0, last: 0, tiles: 0, paid: 0, words: 0, n7: 0, endbal: 0, unpl: 0, actual: 0, firstWin: 0, noWinBy20: 0 });

const BAGC = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

async function body(job: { spec: { type: string; params?: object }; file: string; sel: string; matches: number; seed: number; part: number; parts: number }): Promise<RAgg> {
  const { Dict } = await import("./words.js");
  const { mulberry32 } = await import("./engine.js");
  const O = await import("../src/core/ours.js");
  const dict = new Dict(path.join(process.cwd(), "data", "wordlist.txt"));
  const lines = fs.readFileSync(job.file, "utf8").split("\n").filter(Boolean);
  let recs = lines.map((l) => JSON.parse(l) as Rec);
  if (job.sel === "tournament") recs = recs.filter((r) => r.tournament);
  recs.sort((a, b) => a.id - b.id);
  if (job.sel === "recent") recs = recs.slice(-6000);
  // deterministic subset, split across workers
  const pick = mulberry32(job.seed);
  const chosen: Rec[] = [];
  const pool = recs.slice();
  for (let i = 0; i < job.matches && pool.length; i++) {
    const j = Math.floor(pick() * pool.length);
    chosen.push(pool.splice(j, 1)[0]!);
  }
  const mine = chosen.filter((_, i) => i % job.parts === job.part);
  const p: import("../src/core/ours.js").OurParams = { ...O.DEFAULT_OURS, ...(job.spec.params ?? {}) };
  const agg = zero();
  for (const rec of mine) {
    const rng = mulberry32(rec.id * 7919 + job.seed);
    const seatIdx = Math.floor(rng() * 6);
    const X = rec.bots[seatIdx]!;
    const total = rec.letters.length;
    // unauctioned tiles -> random 5 for our start rack
    const pool26 = Array.from(BAGC);
    for (const ch of rec.letters) pool26[ch.charCodeAt(0) - 65]!--;
    const tiles: number[] = [];
    for (let c = 0; c < 26; c++) for (let k = 0; k < pool26[c]!; k++) tiles.push(c);
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
    }
    const rack = new Int8Array(26);
    const start = new Int8Array(26);
    for (let k = 0; k < 5; k++) {
      rack[tiles[k]!]!++;
      start[tiles[k]!]!++;
    }
    const seen = new Int8Array(26);
    let balance = 100;
    let score = 0;
    let tilesWon = 0;
    let paidTot = 0;
    let words = 0;
    let n7 = 0;
    let first = -1;
    const playNow = (auctionsLeft: number) => {
      const idxs =
        job.spec.type === "starter"
          ? []
          : O.ourWords(p, dict, rack, auctionsLeft, balance);
      for (const i of idxs) {
        const o = i * 26;
        let ok = true;
        for (let c = 0; c < 26; c++) if (dict.counts[o + c]! > rack[c]!) ok = false;
        if (!ok) continue;
        for (let c = 0; c < 26; c++) rack[c]! -= dict.counts[o + c]!;
        score += dict.rewards[i]!;
        balance += dict.rewards[i]!;
        words++;
        if (dict.lens[i]! >= 7) n7++;
      }
    };
    for (let r = 0; r < total; r++) {
      const letter = rec.letters.charCodeAt(r) - 65;
      seen[letter]!++;
      const hasWinner = rec.winner[r] !== "-1";
      const rival = !hasWinner ? 0 : rec.winner[r] === X ? rec.paid[r]! : rec.top[r]!;
      const unseen = new Int8Array(26);
      for (let c = 0; c < 26; c++) unseen[c] = BAGC[c]! - seen[c]! - start[c]!;
      let bid = O.ourBid(p, dict, { letter, roundsLeft: total - r, balance, rack, unseen, round: r }, rng);
      bid = Math.min(Math.floor(bid), balance);
      if (bid > 0 && (bid > rival || (bid === rival && rng() < 0.5))) {
        const pay = Math.max(rival, Math.min(1, bid));
        if (pay <= balance) {
          balance -= pay;
          rack[letter]!++;
          tilesWon++;
          paidTot += pay;
          if (first < 0) first = r;
        }
      }
      const left = total - r - 1;
      if (left >= 1) playNow(left);
    }
    let unpl = 0;
    for (let c = 0; c < 26; c++) unpl += rack[c]!;
    const others = rec.scores.filter((_, i) => i !== seatIdx);
    const better = others.filter((s) => s > score).length;
    agg.n++;
    agg.score += score;
    agg.scoreSq += score * score;
    agg.place += better + 1;
    if (better === 0) agg.wins++;
    if (others.every((s) => s >= score)) agg.last++;
    agg.tiles += tilesWon;
    agg.paid += tilesWon ? paidTot / tilesWon : 0;
    agg.words += words;
    agg.n7 += n7;
    agg.endbal += balance;
    agg.unpl += unpl;
    agg.actual += rec.scores[seatIdx]!;
    agg.firstWin += first < 0 ? total : first;
    if (first < 0 || first >= 20) agg.noWinBy20++;
  }
  return agg;
}

export function replay(spec: { type: string; params?: object }, matches: number, seed: number, sel = "all", workers = Number(process.env.SIM_WORKERS) || Math.max(1, os.cpus().length - 1)): Promise<RAgg> {
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
  const file = path.join(process.cwd(), "data", "replay.jsonl");
  return Promise.all(
    Array.from({ length: workers }, (_, part) =>
      new Promise<RAgg>((res, rej) => {
        const w = new Worker(here, { workerData: { entry: "./replay.ts", spec, file, sel, matches, seed, part, parts: workers } });
        w.on("message", (m) => res(m as RAgg));
        w.on("error", rej);
      }),
    ),
  ).then((all) => {
    const t = zero();
    for (const a of all) for (const k of Object.keys(t) as (keyof RAgg)[]) t[k] += a[k];
    return t;
  });
}

export function fmtR(label: string, a: RAgg): string {
  const n = a.n;
  const mean = a.score / n;
  const sd = Math.sqrt(Math.max(0, a.scoreSq / n - mean * mean));
  return `${label.padEnd(20)} score ${mean.toFixed(1).padStart(6)}±${((1.96 * sd) / Math.sqrt(n)).toFixed(1)} (replaced bots avg ${(a.actual / n).toFixed(1)})  place ${(a.place / n).toFixed(2)}  win ${((100 * a.wins) / n).toFixed(0)}%  last ${((100 * a.last) / n).toFixed(0)}%  tiles ${(a.tiles / n).toFixed(1)} $/t ${(a.paid / n).toFixed(1)} words ${(a.words / n).toFixed(1)} n7+ ${(a.n7 / n).toFixed(1)} endbal ${(a.endbal / n).toFixed(0)} nowin<20 ${((100 * a.noWinBy20) / n).toFixed(0)}% [n=${n}]`;
}

if (!isMainThread) {
  body(workerData).then((a) => parentPort!.postMessage(a));
} else if (process.argv[1]?.endsWith("replay.ts")) {
  const exps = JSON.parse(process.argv[2] ?? '{"ours":{}}') as Record<string, Record<string, number>>;
  const matches = Number(process.argv[3] ?? 400);
  const seed = Number(process.argv[4] ?? 5);
  const sel = process.argv[5] ?? "all";
  (async () => {
    for (const [label, params] of Object.entries(exps)) {
      const t0 = Date.now();
      const a = await replay({ type: "ours", params }, matches, seed, sel);
      console.log(fmtR(label, a) + `  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    process.exit(0);
  })();
}
