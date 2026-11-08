# Handoff: continuing the ScrabbleBot work on another machine

Goal: win the Spacetime **ScrabbleBot track** at HackUTD 2026 (live competition Saturday night, roughly 10:45-11 PM;
prizes $1,024 / $512 / $256; this repo must be public). Our bot is **TileHoarder** (bot id 187) on the
`scrabblebot` database at `https://maincloud.spacetimedb.com`. Repo: https://github.com/Aryan61056/tile-hoarders-scrabblebot

## Where things stand (honest)

- The bot works end to end and is about **field average**: replay and live results are about 74-75 points, place about 3.6 of 6.
  The best HackUTD bots (GodOfThudner id 171, RackMaw id 193, LexForge-1107 id 207) average 97-102 and place about 1.8-2.0.
- **Diagnosis:** top bots win about 13.6-14.2 tiles spread evenly from round 0, spending 184-193 coins at about $13.5 per tile.
  Ours wins about 10.2 tiles and almost none in the first 20 rounds (spends about 143). Our Monte Carlo valuation underbids early.
- **In flight:** an opening bid floor (`earlyFloor`, `earlyRounds`, `floorMaxPrice` in `bot/src/core/ours.ts`, default OFF).
  The 5-config replay test (base, floor 1.0/1.2/1.4 over 25 rounds, floor 1.0 over 40 rounds) never finished because the
  old laptop ran out of RAM. **Run it first on the new machine:**

```bash
cd bot && npm install && gunzip -k data/replay.jsonl.gz
SIM_WORKERS=8 npx tsx sim/replay.ts '{"base":{},"floor 1.0 x25":{"earlyFloor":1.0},"floor 1.2 x25":{"earlyFloor":1.2},"floor 1.0 x40":{"earlyFloor":1.0,"earlyRounds":40},"floor 1.4 x25":{"earlyFloor":1.4}}' 600 5 all
```

  Read the `score`, `tiles`, `endbal` and `nowin<20` columns. Standard error is about 2 points at n=300 and about 1.5 at n=600,
  so only trust gaps above about 3. Use `SIM_WORKERS` up to cores-1; with 64 GB RAM it will not swap.
  If a floor wins: set it in `DEFAULT_OURS` (or pass `PARAMS='{"earlyFloor":1.2}'` to the live bot), push, and let it play live.
  Other ideas if the floor does not help: raise `kappa`/`pWin` early only, an early cash-starvation guard, `search.ts` hill climbing.
- Caveats about the evaluator: `sim/replay.ts` replays 17,048 recorded all-human matches, so rivals do not react to us.
  The passive simulator in `sim/run.ts` was wildly optimistic (104 vs about 75 live); do not trust it for decisions.

## Setup on the new machine

1. Install Node 20+ and git. Clone the repo: `git clone https://github.com/Aryan61056/tile-hoarders-scrabblebot && cd tile-hoarders-scrabblebot/bot && npm install`.
2. **Credentials (the one thing not in the repo).** The bot logs in with a SpacetimeDB identity token stored in `bot/.token-TileHoarder`.
   On Aryan's machine, send that single file to the friend's machine privately (AirDrop or USB; not chat, not git; it is git-ignored).
   Put it at `bot/.token-TileHoarder`. Anyone holding it can act as the bot, so delete it afterwards.
3. **Run the bot on only one machine at a time.** Stop it on the old laptop first, then:
   `cd bot && BOT_NAME=TileHoarder npm run live`. It joins the practice lobby and logs every bid, `ENDED score ...` per match, and lag stats.
   Healthy log: `recvLag` under about 300 ms, `p90rtt` under about 800 ms, small `stale skipped` counter.
4. Optional, to rebuild the replay set from fresh public data: `BOT_NAME=TileHoarder npx tsx src/dump.ts` (writes a large git-ignored
   `data/market-dump.json`), then `python3 tools/make_replay.py`. The committed `data/replay.jsonl.gz` is enough to continue.

## Tournament night checklist

- When the tournament opens, find its id (`spacetime sql scrabblebot "SELECT id,status FROM tournament"` or the site) and run
  `BOT_NAME=TileHoarder TOURNAMENT_ID=<id> npm run live`. The bot must be idle (in no lobby match) when it registers and must stay connected.
- **Stop every simulation and heavy app before the tournament.** Earlier, our own 6-7 worker sims drove load to about 56 and the bot
  missed bids ("Auction closed", disconnects). A quiet machine with a wired or strong connection matters more than tuning.
- Do not commit tokens, `.env*`, or dumps. Do not paste another team's code in (the Nijello bot has no license).
- Only deploy a strategy change if it beat the base on replay by more than the noise AND does not slow bidding (`bid ... Nms` in the log, budget 250 ms).

## Map of the code

| Path | Purpose |
|---|---|
| `bot/src/main.ts` | Live client (`npm run live`): narrow per-match subscriptions, stale-auction skipping, dynamic word dump, auto-reconnect, lobby rejoin every 10 s |
| `bot/src/core/ours.ts` | Strategy: `ourBid` (Monte Carlo marginal value x kappa x pacing, early floor), `ourWords` (when to cash words, cash-starvation rule) |
| `bot/src/core/words.ts` | Dictionary scan and word planner shared by live bot and sims |
| `bot/src/core/table.ts` | Alternative per-letter table bidder (search output in `bot/data/best-table.json`) |
| `bot/sim/replay.ts`, `search.ts` | Counterfactual replay evaluator and policy search (use these) |
| `bot/sim/engine.ts`, `run.ts`, `par.ts`, `tune.ts` | Passive simulator (misleading; kept for reference) |
| `PLAN.md` | Rules read from the upstream game repo and the original plan |

Rules recap: 68 one-second Vickrey auctions per 6-seat match, 100 starting coins, reserve 1, words pay base x (1/1.5/2/2.5/3 at
3/4/5/6/7+ letters) into both score and coins, unbid tiles are discarded, the last auction's tile is unplayable.
Tournament: Swiss, top cut, elimination (last place out), then a 3-game final decided by total score.
