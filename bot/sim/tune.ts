// Usage: npx tsx sim/tune.ts '<json: {label: params, ...}>' [matches] [seed] [copies]
// Params may include "copies" (self-play: total copies of our bot at the table).
import { evaluate, fmt } from "./par.js";

async function main() {
  const exps = JSON.parse(process.argv[2] ?? "{}") as Record<string, Record<string, number>>;
  const matches = Number(process.argv[3] ?? 140);
  const seed = Number(process.argv[4] ?? 11);
  const copiesDefault = Number(process.argv[5] ?? 1);
  for (const [label, raw] of Object.entries(exps)) {
    const { copies, ...params } = raw;
    const t0 = Date.now();
    const a = await evaluate({ spec: { type: "ours", params }, matches, copies: copies ?? copiesDefault }, seed);
    console.log(fmt(label, a) + `  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  process.exit(0);
}
main();
