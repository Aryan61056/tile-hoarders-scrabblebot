# Tile Hoarders: a ScrabbleBot bot

A bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), the Scrabble-style sealed-bid auction game
that SpacetimeDB runs at hackathons. Built for the HackUTD 2026 ScrabbleBot track.
The bot is an external SpacetimeDB client (TypeScript): it bids for tiles, spells words, and rejoins the lobby.

> **Honest status.** On real recorded matches and in live lobby play this bot is about field average
> (score about 75 against a field mean of 74; the best bots average 90 to 100). See "What we learned".

## Layout

| Path | What it is |
|---|---|
| `bot/src/main.ts` | Live client: narrow per-match subscriptions, auto-reconnect, burst word dump in the last auction |
| `bot/src/core/` | Strategy shared by the live bot and the simulators: word planner (`words.ts`), Monte Carlo valuation bot (`ours.ts`), table bidder (`table.ts`) |
| `bot/sim/` | Match engine, calibrated opponent model, parallel runners, and the **replay evaluator** (`replay.ts`, `search.ts`) |
| `bot/src/dump.ts` | Passive read-only dump of the public tables (history, prices, word plays) |
| `tools/` | Python analysis of the dump and the replay dataset builder |
| `PLAN.md` | Working plan and findings |
| `bot/src/module_bindings/` | Generated SpacetimeDB bindings (copied from the game's repo) |

## Running it

```bash
cd bot && npm install
# token: create a team on the site, then either generate a token on /team, or from the CLI:
#   spacetime call scrabblebot mint_credential_nonce ; spacetime sql scrabblebot 'SELECT code FROM my_nonces'
BOT_NAME=<your bot> BOT_NONCE=<code> npm run live     # first run saves .token-<name> (git-ignored)
BOT_NAME=<your bot> npm run live                      # later runs
BOT_NAME=<your bot> TOURNAMENT_ID=<id> npm run live   # also registers for a tournament
```

Strategy parameters can be overridden with `PARAMS='{"kappa":1.2}'`.
Never commit `.token-*` or `.env*`; they are git-ignored.

Evaluate a strategy on real recorded matches (needs `bot/data/replay.jsonl`, built from a dump):

```bash
BOT_NAME=<your bot> npx tsx src/dump.ts            # writes data/market-dump.json (large, git-ignored)
python3 tools/make_replay.py                       # writes data/replay.jsonl
SIM_WORKERS=7 npx tsx sim/replay.ts '{"default":{}}' 500 5 all
```

## What we learned

- **Score is coins converted.** Reward goes into both score and coins; coins left at the end are worthless, and the
  last auction's tile can never be played. Real bots convert about 0.5 points per coin spent.
- **A passive simulator is dangerous.** Our first simulator (opponents that bid a fixed price per letter) said our bot
  scored 104 against a field of 64. Real play gave about 75. We replaced it with a **counterfactual replay** over
  17,048 recorded all-human matches: the highest rival bid on every auction is recorded (the price paid if the replaced
  bot won, else the winning bid), so a replacement bot wins exactly when it would have, at the true price. It
  ignores rivals reacting to us, but our own score depends only on our own tiles.
- **Cash is the binding constraint.** Bidding more across the board loses (the bot runs out of coins). Cashing shorter
  words when coins are low helps a little (table bidder 70.6 to 73.5 on replay).
- **Top bots** buy steadily from round 0 and cash fewer, bigger words (about 49 points each against 36 for the field).
- Word-planner depth does not matter (tripling search depth moved the score by 0.3).

## Credits and licenses

- Game, starter bot and generated bindings: [clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot) (MIT).
  See `bot/LICENSE-upstream-starter`.
- Dictionary: the public-domain ENABLE word list (`bot/data/wordlist.txt`).
- Ideas about pacing, cash starvation and the simulator trap came from public write-ups of other teams' Cal Hacks bots
  (READMEs only). No code or tuned weights from other teams' bots is used here.
- This repository's own code: MIT (see `LICENSE`).
