# HANDOFF: instructions for the Claude agent taking over

You are continuing a project another Claude session built. Read this file fully, then `README.md` and the "Rules" section of
`PLAN.md`, then act. The humans are at HackUTD 2026 and are short on time and sleep: be autonomous, report concisely, ask only
when blocked.

## Mission

Win the Spacetime **ScrabbleBot track** at HackUTD 2026. The live competition is **Saturday night, about 10:45-11 PM**.
Prizes are $1,024 / $512 / $256. The repo must stay **public**: https://github.com/Aryan61056/tile-hoarders-scrabblebot (branch `main`).
Our bot is **TileHoarder** (bot id 187), a TypeScript client of the SpacetimeDB database `scrabblebot` on
`https://maincloud.spacetimedb.com`. The bot is an external client: it bids for tiles, spells words, and rejoins the lobby.
Game source of truth: https://github.com/clockworklabs/scrabblebot (`docs/bot-guide.md`, `spacetimedb/src/game.ts`).

## Current state (honest)

- The bot runs end to end and is about **field average**: replay and live both give about 74-75 points, average place about 3.6 of 6.
  The best bots (GodOfThudner id 171, RackMaw id 193, LexForge-1107 id 207) average 97-102 points and place about 1.8-2.0.
- **Diagnosis:** the top bots win about 13.6-14.2 tiles spread evenly from round 0, spending 184-193 coins at about $13.5 per tile.
  Ours wins about 10.2 tiles with almost none in the first 20 rounds (spends about 143). Our Monte Carlo valuation underbids early.
- **Open experiment:** opening bid floor, params `earlyFloor` (0 = off), `earlyRounds`, `floorMaxPrice` in `bot/src/core/ours.ts`
  (`ourBid`, using the `GOING_PRICE` table). It typechecks, defaults to OFF, and has **never been evaluated**: the previous
  machine ran out of RAM and the replay run was killed. This is your first job.

## Your first actions, in order

1. `cd bot && npm install && gunzip -k data/replay.jsonl.gz` (prebuilt replay set, 17,048 real all-human matches, public data).
2. Run the floor experiment (use all cores minus one; takes a few minutes per config on a fast machine):

```bash
cd bot && SIM_WORKERS=8 npx tsx sim/replay.ts '{"base":{},"floor 1.0 x25":{"earlyFloor":1.0},"floor 1.2 x25":{"earlyFloor":1.2},"floor 1.0 x40":{"earlyFloor":1.0,"earlyRounds":40},"floor 1.4 x25":{"earlyFloor":1.4}}' 600 5 all
```

   Output columns: `score` (mean +- 95% CI), `place`, `tiles`, `$/t`, `endbal`, `nowin<20` (share of matches with no tile won in the first 20 rounds).
   Baseline is about 74-75. Trust only gaps larger than about 3 points. A good result also lifts `tiles` toward 13-14 and
   lowers `nowin<20`, without `endbal` going near 0 early (cash starvation).
3. If a variant wins: set it in `DEFAULT_OURS` (or run live with `PARAMS='{"earlyFloor":1.2}'`), re-run with a different seed
   (e.g. `... 600 11 all`) to confirm, commit, push. If none wins, try the ideas below; keep a log of every config and result in `PLAN.md`.
4. Make sure the live bot is running (see "Running the bot") on **this** machine only.

Other ideas if the floor does not help (each must be validated on replay before deploying):
raise `kappa` or `pWin` only in early rounds; an early-game spend target (about 13 tiles by round 50) instead of a pure value bid;
`bot/sim/search.ts` (persistent-worker policy search; env `TSCALE PACEW PACER SBAL SLEN WORD_BRANCH WORD_DEPTH FRESH SIM_WORKERS`);
phase-aware risk (the elimination round only needs to avoid last place; the 3-game final rewards total score).
Known non-ideas: scaling all bids and pacing (made things worse via cash starvation); deeper word search (+0.3 only).

## How the evaluator works (and what to distrust)

- `bot/sim/replay.ts` takes the seat of one bot in a recorded match. A rival's highest bid per auction is known exactly
  (`paid` if the replaced bot won, else `top`), so we win when we outbid it and pay it (Vickrey). Our own score depends only on our
  own tiles, so this is exact for us given rivals' recorded bids. It ignores rivals reacting to us.
- `bot/sim/run.ts`, `par.ts`, `tune.ts` use a passive simulated field. It said we score 104 when live play gave about 75.
  **Do not make decisions from it.**
- Replay standard error is about 2 points at n=300 and about 1.5 at n=600. Paired comparisons on the same matches (same seed) are fair.

## Running the bot

```bash
cd bot
BOT_NAME=TileHoarder npm run live                      # practice lobby
BOT_NAME=TileHoarder TOURNAMENT_ID=<id> npm run live   # registers for a tournament too
```

- **Credentials are not in the repo.** The bot authenticates with `bot/.token-TileHoarder` (a SpacetimeDB identity token,
  git-ignored). The human copies it from the other machine by AirDrop/USB, or sets `BOT_TOKEN`. If it is missing, ask the
  human for it. Never print it, never commit it, never put it in a URL or message.
- Run the bot on **one machine at a time**. Anything that starts it must first make sure the other copy is stopped.
- Healthy log lines look like `m45140 r26 'O' bid 8 (bal 52, 439ms, recvLag 203ms, p90rtt 1469ms, stale skipped 84)` and
  `m... ENDED score 92 balance 3`. Trouble: `recvLag` above about 1 s, `p90rtt` above about 1.5 s, growing `stale skipped`, repeated
  `reconnecting`, many scores of 0 (the machine is overloaded or the network is bad; stop other work).
- Find the tournament: `spacetime sql scrabblebot "SELECT id,status FROM tournament"` (the column `name` does not exist; use `*`
  if unsure). The bot must be **idle (in no match) when it starts** and **stay connected** through the tournament.
- Env knobs: `PARAMS` (JSON overrides for `OurParams`), `BID_BUDGET_MS` (default 250), `STDB_HOST`, `STDB_DB`.

## Rules recap

98 tiles. 6 bots per match, each with 5 start tiles and 100 coins. 68 one-second **Vickrey** auctions (winner pays the second
bid, reserve 1). Playing a word is instant and pays `base x multiplier` (1 / 1.5 / 2 / 2.5 / 3 for 3 / 4 / 5 / 6 / 7+ letters) into
both `score` and `balance`. Only `score` ranks bots; coins left at the end are worthless. The last auction's tile cannot be played;
unbid tiles are discarded. Rounds left, counting the open auction, = `bagTotal + 1`. Tournament: Swiss, top cut, elimination (last
place out), then a 3-game final decided by total score. Real data: score is about 0.535 x coins spent; typical tile price about
$13.5; field mean about 74, winners about 109.

## Code map

| Path | Purpose |
|---|---|
| `bot/src/main.ts` | Live client: narrow subscriptions (my bot, my rack, per-match tables), skips stale auctions (`closesAt - 100 ms`), dynamic word dump by measured latency, auto-reconnect, lobby join loop every 10 s |
| `bot/src/core/ours.ts` | `OurParams`, `DEFAULT_OURS`, `marginalValue` (Monte Carlo over the unseen pool), `ourBid`, `ourWords` (cash words by length, cash-starvation rule) |
| `bot/src/core/words.ts` | `Dict` (ENABLE word scan), `planValue`, `planWords`, reward multipliers |
| `bot/src/core/table.ts` | Alternative per-letter table bidder (`bot/data/best-table.json`) |
| `bot/sim/replay.ts`, `search.ts` | Counterfactual replay evaluator and policy search (use these) |
| `bot/src/dump.ts`, `tools/make_replay.py` | Rebuild the replay set from fresh public data: `BOT_NAME=TileHoarder npx tsx src/dump.ts` then `python3 tools/make_replay.py` |
| `bot/src/module_bindings/` | Generated SpacetimeDB bindings (copied from the game repo; do not hand-edit) |

## Standing rules from the humans

- Keep tokens, secrets and `.env*` out of the repo, chat and logs. The repo is public.
- Ask before downloading or installing anything outside `npm install` for this repo.
- Do **not** reuse other teams' code (the Nijello bot has no license). Ideas from public write-ups are fine.
- Everything you commit must be our own work or properly licensed. Commit with a clear message and push to `main`; never force-push.
- Do not touch the other (main track) project the humans are working on.

## Gotchas learned the hard way

- **Run nothing heavy during the tournament.** Our own 6-7 worker simulations once drove load to about 56 and the live bot missed
  bids ("Auction closed"), disconnected, and scored 0. Low-priority simulations (`nice -n 19`) with fewer workers are fine in
  practice play; stop all of them before the tournament. Check `uptime` before blaming the bot.
- A previous laptop hit 700+ load average from swap exhaustion (not from us). If the log shows `p90rtt` jumping, check memory with `vm_stat` and swap with `sysctl vm.swapusage`.
- `spacetime call` takes separate arguments, not a JSON array.
- macOS has no `timeout` command, and foreground `sleep` may be blocked in this harness: use background commands plus a monitor.
- In zsh, `for x in $var` does not word-split. Use functions with explicit arguments or `while read`.
- Worker threads cannot load `.ts`; `bot/sim/worker.mjs` bootstraps `tsx`. Keep using it.
- Subscribing to all tables loads about 1.7 million rows and takes about 40 s. `main.ts` deliberately uses narrow queries; keep it that way.
- Server lag bursts (recvLag up to 16 s) happen and are partly server-side. The bot already skips stale auctions and dumps words earlier when latency is high.

## Reporting

After each experiment, tell the humans: what you changed, the replay score versus base with the CI, and whether you deployed it.
When something needs a human (the token file, the tournament id, a decision), ask in one short question.
Before you finish a session: commit and push your work, update this file's "Current state" section, and leave the bot running or
say clearly that it is stopped.
