// Direct policy search on real recorded rival bids.
//   npx tsx sim/search.ts [iterations] [trainN] [testN] [seed]
// Persistent workers each hold a slice of the replay matches and the dictionary; the main thread
// proposes parameter vectors and keeps improvements (hill-climbing with paired, common matches).
// Best parameters are written to data/best-table.json after every improvement.

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
interface Ag {
  n: number;
  score: number;
  place: number;
  wins: number;
  last: number;
  tiles: number;
  paid: number;
  n7: number;
  words: number;
  actual: number;
}
const zero = (): Ag => ({ n: 0, score: 0, place: 0, wins: 0, last: 0, tiles: 0, paid: 0, n7: 0, words: 0, actual: 0 });
const BAGC = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

// ---------------- worker side ----------------
async function workerMain() {
  const { Dict } = await import("./words.js");
  const { mulberry32 } = await import("./engine.js");
  const O = await import("../src/core/ours.js");
  const Tb = await import("../src/core/table.js");
  const W = await import("./words.js");
  const dict = new Dict(path.join(process.cwd(), "data", "wordlist.txt"));
  const { part, parts, trainN, testN, seed, sel } = workerData as { part: number; parts: number; trainN: number; testN: number; seed: number; sel: string };
  let recs = fs
    .readFileSync(path.join(process.cwd(), "data", "replay.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec);
  recs.sort((a, b) => a.id - b.id);
  if (sel === "recent") recs = recs.slice(-8000);
  const pick = mulberry32(seed);
  const pool = recs.slice();
  const take = (n: number) => {
    const out: Rec[] = [];
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(Math.floor(pick() * pool.length), 1)[0]!);
    return out;
  };
  const train = take(trainN).filter((_, i) => i % parts === part);
  const test = take(testN).filter((_, i) => i % parts === part);
  const wordP = { ...O.DEFAULT_OURS, branch: Number(process.env.WORD_BRANCH ?? 2), depth: Number(process.env.WORD_DEPTH ?? 0) };

  const TSCALE = Number(process.env.TSCALE ?? 1);
  function evalRec(rec: Rec, p0: import("../src/core/table.js").TableParams, ag: Ag) {
    const p = { ...p0, starveBal: process.env.SBAL !== undefined ? Number(process.env.SBAL) : p0.starveBal, starveLen: process.env.SLEN !== undefined ? Number(process.env.SLEN) : p0.starveLen, T: TSCALE === 1 ? p0.T : p0.T.map((x) => x * TSCALE), paceW: process.env.PACEW !== undefined ? Number(process.env.PACEW) : p0.paceW, paceRate: process.env.PACER !== undefined ? Number(process.env.PACER) : p0.paceRate };
    const total = rec.letters.length;
    const rng = mulberry32(rec.id * 7919 + 11);
    const seatIdx = Math.floor(rng() * 6);
    const X = rec.bots[seatIdx]!;
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
    const unseen = new Int8Array(26);
    let balance = 100;
    let score = 0;
    let won = 0;
    let paidTot = 0;
    let words = 0;
    let n7 = 0;
    let dirty = true;
    const wp = { ...wordP, playLen: p.playLen, dumpAt: p.dumpAt };
    for (let r = 0; r < total; r++) {
      const letter = rec.letters.charCodeAt(r) - 65;
      seen[letter]!++;
      const hasW = rec.winner[r] !== "-1";
      const rival = !hasW ? 0 : rec.winner[r] === X ? rec.paid[r]! : rec.top[r]!;
      for (let c = 0; c < 26; c++) unseen[c] = BAGC[c]! - seen[c]! - start[c]!;
      const bid = Math.min(Math.floor(Tb.tableBid(p, { letter, roundsLeft: total - r, balance, rack, unseen, won, round: r })), balance);
      if (bid > 0 && (bid > rival || (bid === rival && ((rec.id + r) & 1) === 0))) {
        const pay = Math.max(rival, Math.min(1, bid));
        if (pay <= balance) {
          balance -= pay;
          rack[letter]!++;
          won++;
          paidTot += pay;
          dirty = true;
        }
      }
      const left = total - r - 1;
      const starved = p.starveBal > 0 && balance < p.starveBal && left > p.dumpAt;
      if (left >= 1 && (dirty || left <= p.dumpAt || starved)) {
        dirty = false;
        let idxs = O.ourWords(wp, dict, rack, left);
        if (starved) {
          // cash the best disjoint words (>= starveLen letters) until coins recover
          const plan = W.planWords(dict, rack, 3, 1).filter((i) => dict.lens[i]! >= p.starveLen);
          plan.sort((a, b) => dict.rewards[b]! - dict.rewards[a]!);
          let b2 = balance;
          const extra: number[] = [];
          for (const i of plan) {
            if (b2 >= p.starveBal * 1.6) break;
            extra.push(i);
            b2 += dict.rewards[i]!;
          }
          idxs = Array.from(new Set([...idxs, ...extra]));
        }
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
          dirty = true;
        }
      }
    }
    const others = rec.scores.filter((_, i) => i !== seatIdx);
    const better = others.filter((s) => s > score).length;
    ag.n++;
    ag.score += score;
    ag.place += better + 1;
    if (better === 0) ag.wins++;
    if (others.every((s) => s >= score)) ag.last++;
    ag.tiles += won;
    ag.paid += won ? paidTot / won : 0;
    ag.n7 += n7;
    ag.words += words;
    ag.actual += rec.scores[seatIdx]!;
  }
  parentPort!.on("message", (m: { id: number; theta: import("../src/core/table.js").TableParams; set: "train" | "test" }) => {
    const ag = zero();
    for (const rec of m.set === "train" ? train : test) evalRec(rec, m.theta, ag);
    parentPort!.postMessage({ id: m.id, ag });
  });
  parentPort!.postMessage({ ready: true });
}

// ---------------- main side ----------------
async function main() {
  const iterations = Number(process.argv[2] ?? 300);
  const trainN = Number(process.argv[3] ?? 1200);
  const testN = Number(process.argv[4] ?? 1400);
  const seed = Number(process.argv[5] ?? 3);
  const sel = process.argv[6] ?? "all";
  const nW = Number(process.env.SIM_WORKERS) || Math.max(1, os.cpus().length - 1);
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
  const { DEFAULT_TABLE } = await import("../src/core/table.js");
  type TP = typeof DEFAULT_TABLE;

  const workers: Worker[] = [];
  await Promise.all(
    Array.from({ length: nW }, (_, part) =>
      new Promise<void>((res, rej) => {
        const w = new Worker(here, { workerData: { entry: "./search.ts", part, parts: nW, trainN, testN, seed, sel } });
        w.once("message", () => res());
        w.once("error", rej);
        workers.push(w);
      }),
    ),
  );
  let msgId = 0;
  const evaluate = (theta: TP, set: "train" | "test"): Promise<Ag> => {
    const id = ++msgId;
    return Promise.all(
      workers.map(
        (w) =>
          new Promise<Ag>((res) => {
            const h = (m: { id: number; ag: Ag }) => {
              if (m.id === id) {
                w.off("message", h);
                res(m.ag);
              }
            };
            w.on("message", h);
            w.postMessage({ id, theta, set });
          }),
      ),
    ).then((all) => {
      const t = zero();
      for (const a of all) for (const k of Object.keys(t) as (keyof Ag)[]) t[k] += a[k];
      return t;
    });
  };
  const line = (label: string, a: Ag) =>
    `${label} score ${(a.score / a.n).toFixed(1)} (replaced ${(a.actual / a.n).toFixed(1)}) place ${(a.place / a.n).toFixed(2)} win ${((100 * a.wins) / a.n).toFixed(0)}% last ${((100 * a.last) / a.n).toFixed(0)}% tiles ${(a.tiles / a.n).toFixed(1)} $/t ${(a.paid / a.n).toFixed(1)} n7+ ${(a.n7 / a.n).toFixed(1)} [n=${a.n}]`;

  // resume from a previous best if present
  const outFile = path.join(process.cwd(), "data", "best-table.json");
  let best: TP = fs.existsSync(outFile) && process.env.FRESH !== "1" ? JSON.parse(fs.readFileSync(outFile, "utf8")) : DEFAULT_TABLE;
  let bestAg = await evaluate(best, "train");
  console.log(line("start  train", bestAg));
  console.log(line("start  test ", await evaluate(best, "test")));

  const rngState = { s: seed * 2654435761 };
  const rnd = () => {
    rngState.s = (rngState.s * 1664525 + 1013904223) >>> 0;
    return rngState.s / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());
  const scalarKeys: (keyof TP)[] = ["beta", "rho0", "vb", "vtarget", "dup", "lateBoost", "paceRate", "paceW"];
  let sigma = 0.25;
  let accepted = 0;
  const t0 = Date.now();
  for (let it = 1; it <= iterations; it++) {
    const cand: TP = JSON.parse(JSON.stringify(best));
    const k = 1 + Math.floor(rnd() * 4);
    const desc: string[] = [];
    for (let j = 0; j < k; j++) {
      const r = rnd();
      if (r < 0.78) {
        const L = Math.floor(rnd() * 26);
        cand.T[L] = Math.max(1, cand.T[L]! * Math.exp(sigma * gauss()));
        desc.push(`T${String.fromCharCode(65 + L)}`);
      } else if (r < 0.95) {
        const key = scalarKeys[Math.floor(rnd() * scalarKeys.length)]!;
        (cand[key] as number) = Math.max(0.05, (cand[key] as number) * Math.exp(sigma * gauss()));
        desc.push(String(key));
      } else if (r < 0.975) {
        cand.playLen = 6 + Math.floor(rnd() * 3);
        desc.push("playLen");
      } else {
        cand.lateSpend = 3 + Math.floor(rnd() * 14);
        desc.push("lateSpend");
      }
    }
    cand.vtarget = Math.min(0.6, cand.vtarget);
    const a = await evaluate(cand, "train");
    if (a.score > bestAg.score + 0.15 * a.n) {
      best = cand;
      bestAg = a;
      accepted++;
      fs.writeFileSync(outFile, JSON.stringify(best, null, 1));
      console.log(`it ${it} + ${desc.join(",")} ${line("train", a)}  [${Math.round((Date.now() - t0) / 1000)}s]`);
    }
    if (it % 40 === 0) {
      sigma = Math.max(0.07, sigma * 0.88);
      console.log(`it ${it} sigma ${sigma.toFixed(2)} accepted ${accepted} | ${line("TEST", await evaluate(best, "test"))}`);
    }
  }
  console.log("FINAL", line("train", bestAg), "\n", line("test ", await evaluate(best, "test")));
  console.log(JSON.stringify(best));
  process.exit(0);
}

if (!isMainThread) {
  workerMain();
} else if (process.argv[1]?.endsWith("search.ts")) {
  main();
}
