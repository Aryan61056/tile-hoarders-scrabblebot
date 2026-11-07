// Parallel evaluation: each worker plays `matches` matches with our candidate in a random seat
// against calibrated field bots, and returns summed metrics.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

export interface Spec {
  type: "ours" | "starter" | "field";
  params?: unknown;
}
export interface Job {
  spec: Spec;
  field?: unknown;
  matches: number;
  seed: number;
  copies?: number; // total copies of our bot at the table (self-play)
}
export interface Agg {
  n: number;
  score: number;
  place: number;
  wins: number;
  last: number;
  tiles: number;
  paid: number;
  words: number;
  n7: number;
  endbal: number;
  unplayed: number;
  fieldScore: number;
  scoreSq: number;
}

async function work(job: Job): Promise<Agg> {
  const { Dict } = await import("./words.js");
  const { mulberry32, runMatch } = await import("./engine.js");
  const S = await import("./strategies.js");
  const dict = new Dict(path.join(process.cwd(), "data", "wordlist.txt"));
  const rng = mulberry32(job.seed);
  const fp = { ...S.DEFAULT_FIELD, ...((job.field as object) ?? {}) };
  const agg: Agg = { n: 0, score: 0, place: 0, wins: 0, last: 0, tiles: 0, paid: 0, words: 0, n7: 0, endbal: 0, unplayed: 0, fieldScore: 0, scoreSq: 0 };
  for (let m = 0; m < job.matches; m++) {
    const seat = Math.floor(rng() * 6);
    const strats = Array.from({ length: 6 }, () => S.makeFieldBot(fp, rng));
    strats[seat] =
      job.spec.type === "ours"
        ? S.makeOurBot({ ...S.DEFAULT_OURS, ...((job.spec.params as object) ?? {}) })
        : job.spec.type === "starter"
          ? S.makeStarterBot()
          : S.makeFieldBot(fp, rng);
    // self-play: extra copies of our bot sit at other seats (measured seat stays `seat`)
    const copies = job.copies ?? 1;
    for (let c = 1, s2 = (seat + 1) % 6; c < copies; c++, s2 = (s2 + 1) % 6) {
      strats[s2] = S.makeOurBot({ ...S.DEFAULT_OURS, ...((job.spec.params as object) ?? {}) });
    }
    const r = runMatch(dict, strats, rng);
    const me = r.players[seat]!;
    const better = r.players.filter((p) => p.score > me.score).length;
    agg.n++;
    agg.score += me.score;
    agg.scoreSq += me.score * me.score;
    agg.place += better + 1;
    if (better === 0) agg.wins++;
    if (r.players.every((p) => p.score >= me.score)) agg.last++;
    agg.tiles += me.tilesWon;
    agg.paid += me.tilesWon ? me.paidTotal / me.tilesWon : 0;
    agg.words += me.words.length;
    agg.n7 += me.wordPlays.filter((w) => w.len >= 7).length;
    agg.endbal += me.balance;
    agg.unplayed += me.unplayed;
    for (let i = 0; i < 6; i++) if (i !== seat) agg.fieldScore += r.players[i]!.score / 5;
  }
  return agg;
}

export function evaluate(
  job: Omit<Job, "seed">,
  seed = 1,
  workers = Number(process.env.SIM_WORKERS) || Math.max(1, os.cpus().length - 1),
): Promise<Agg> {
  const per = Math.ceil(job.matches / workers);
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
  const parts: Promise<Agg>[] = [];
  for (let w = 0; w < workers; w++) {
    parts.push(
      new Promise((resolve, reject) => {
        const wk = new Worker(here, {
          workerData: { ...job, matches: per, seed: seed * 1000 + w },
        });
        wk.on("message", (m) => resolve(m as Agg));
        wk.on("error", reject);
      }),
    );
  }
  return Promise.all(parts).then((all) => {
    const t: Agg = { n: 0, score: 0, place: 0, wins: 0, last: 0, tiles: 0, paid: 0, words: 0, n7: 0, endbal: 0, unplayed: 0, fieldScore: 0, scoreSq: 0 };
    for (const a of all) for (const k of Object.keys(t) as (keyof Agg)[]) t[k] += a[k];
    return t;
  });
}

export function fmt(label: string, a: Agg): string {
  const n = a.n;
  const mean = a.score / n;
  const sd = Math.sqrt(Math.max(0, a.scoreSq / n - mean * mean));
  const se = sd / Math.sqrt(n);
  return `${label.padEnd(26)} score ${mean.toFixed(1).padStart(6)}±${(1.96 * se).toFixed(1)} (field ${(a.fieldScore / n).toFixed(1)})  place ${(a.place / n).toFixed(2)}  win ${((100 * a.wins) / n).toFixed(0)}%  last ${((100 * a.last) / n).toFixed(0)}%  tiles ${(a.tiles / n).toFixed(1)} $/t ${(a.paid / n).toFixed(1)} words ${(a.words / n).toFixed(1)} n7+ ${(a.n7 / n).toFixed(1)} endbal ${(a.endbal / n).toFixed(0)} unpl ${(a.unplayed / n).toFixed(1)} [n=${n}]`;
}

if (!isMainThread) {
  work(workerData as Job).then((a) => parentPort!.postMessage(a));
}
