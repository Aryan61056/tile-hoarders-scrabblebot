// Usage: npx tsx sim/run.ts calibrate [matches]
//        npx tsx sim/run.ts compare [matches]
import * as path from "node:path";
import { Dict } from "./words.js";
import { mulberry32, runMatch, Strategy } from "./engine.js";
import {
  DEFAULT_FIELD,
  DEFAULT_OURS,
  FieldParams,
  OurParams,
  makeFieldBot,
  makeOurBot,
  makeStarterBot,
} from "./strategies.js";

const dict = new Dict(path.join(process.cwd(), "data", "wordlist.txt"));

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
};

export function calibrate(matches: number, fp: FieldParams = DEFAULT_FIELD, seed = 1) {
  const rng = mulberry32(seed);
  const scores: number[] = [];
  const winners: number[] = [];
  const seconds: number[] = [];
  const tiles: number[] = [];
  const paid: number[] = [];
  const nwords: number[] = [];
  const lenCount = new Map<number, number>();
  const unplayed: number[] = [];
  const endBal: number[] = [];
  const ratio: number[] = [];
  for (let m = 0; m < matches; m++) {
    const strats = Array.from({ length: 6 }, () => makeFieldBot(fp, rng));
    const r = runMatch(dict, strats, rng);
    const sc = r.players.map((p) => p.score).sort((a, b) => b - a);
    winners.push(sc[0]!);
    seconds.push(sc[1]!);
    for (const p of r.players) {
      scores.push(p.score);
      tiles.push(p.tilesWon);
      nwords.push(p.words.length);
      unplayed.push(p.unplayed);
      endBal.push(p.balance);
      for (const w of p.wordPlays) lenCount.set(w.len, (lenCount.get(w.len) ?? 0) + 1);
    }
    for (const pr of r.prices) {
      paid.push(pr.paid);
      ratio.push(pr.top / Math.max(1, pr.paid));
    }
  }
  const totalWords = [...lenCount.values()].reduce((a, b) => a + b, 0);
  const pct = (l: number) => ((100 * (lenCount.get(l) ?? 0)) / totalWords).toFixed(0);
  console.log(`calibration over ${matches} matches (target in brackets, from real all-human data)`);
  console.log(`  mean score ${mean(scores).toFixed(1)} [73.7]   winner ${mean(winners).toFixed(1)} [108.6]   2nd ${mean(seconds).toFixed(1)} [91.5]`);
  console.log(`  tiles/bot ${mean(tiles).toFixed(2)} [11.2]   paid mean ${mean(paid).toFixed(1)} [13.2] median ${median(paid)} [12]   topbid/paid median ${median(ratio.map((x) => Math.round(x * 100))) / 100} [~1.3]`);
  console.log(`  words/bot ${mean(nwords).toFixed(2)} [2.7]   len%: 2:${pct(2)} [14] 3:${pct(3)} 4:${pct(4)} 5:${pct(5)} 6:${pct(6)} 7:${pct(7)} [38] 8:${pct(8)}`);
  console.log(`  unplayed tiles/bot ${mean(unplayed).toFixed(2)}   end balance ${mean(endBal).toFixed(1)} [~20-30]`);
}

export function compare(
  label: string,
  make: (rng: () => number) => Strategy,
  matches: number,
  fp: FieldParams = DEFAULT_FIELD,
  seed = 7,
) {
  const rng = mulberry32(seed);
  const sc: number[] = [];
  const place: number[] = [];
  let wins = 0;
  let last = 0;
  const tiles: number[] = [];
  const paid: number[] = [];
  const wordsN: number[] = [];
  const n7: number[] = [];
  const endBal: number[] = [];
  const unpl: number[] = [];
  const fieldSc: number[] = [];
  const t0 = Date.now();
  for (let m = 0; m < matches; m++) {
    const seat = Math.floor(rng() * 6);
    const strats: Strategy[] = Array.from({ length: 6 }, () => makeFieldBot(fp, rng));
    strats[seat] = make(rng);
    const r = runMatch(dict, strats, rng);
    const me = r.players[seat]!;
    const order = r.players.map((p, i) => ({ i, s: p.score })).sort((a, b) => b.s - a.s);
    const rank = order.findIndex((o) => o.i === seat);
    // ties share the better place
    const better = r.players.filter((p) => p.score > me.score).length;
    place.push(better + 1);
    if (better === 0) wins++;
    if (r.players.filter((p) => p.score < me.score).length === 0) last++;
    sc.push(me.score);
    tiles.push(me.tilesWon);
    paid.push(me.tilesWon ? me.paidTotal / me.tilesWon : 0);
    wordsN.push(me.words.length);
    n7.push(me.wordPlays.filter((w) => w.len >= 7).length);
    endBal.push(me.balance);
    unpl.push(me.unplayed);
    for (let i = 0; i < 6; i++) if (i !== seat) fieldSc.push(r.players[i]!.score);
    void rank;
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `${label.padEnd(22)} score ${mean(sc).toFixed(1).padStart(6)} (field ${mean(fieldSc).toFixed(1)})  place ${mean(place).toFixed(2)}  win ${(100 * wins / matches).toFixed(0)}%  last ${(100 * last / matches).toFixed(0)}%  tiles ${mean(tiles).toFixed(1)} $/tile ${mean(paid).toFixed(1)} words ${mean(wordsN).toFixed(1)} n7+ ${mean(n7).toFixed(1)} endbal ${mean(endBal).toFixed(0)} unplayed ${mean(unpl).toFixed(1)}  [${secs.toFixed(0)}s, n=${matches}]`,
  );
}

if (process.argv[1]?.endsWith("run.ts")) {
  const cmd = process.argv[2] ?? "calibrate";
  const n = Number(process.argv[3] ?? 300);
  if (cmd === "calibrate") calibrate(n);
  if (cmd === "sweep") {
    for (const scale of [0.9, 1.0]) {
      for (const sigma of [0.2, 0.3]) {
        console.log(`\n--- scale ${scale} sigma ${sigma}`);
        calibrate(n, { ...DEFAULT_FIELD, scale, sigma });
      }
    }
  }
  if (cmd === "compare") {
    compare("starter", () => makeStarterBot(), n);
    compare("field-clone", (rng) => makeFieldBot(DEFAULT_FIELD, rng), n);
    compare("ours(default)", () => makeOurBot(DEFAULT_OURS), Math.min(n, 100));
  }
}

export type { OurParams };
