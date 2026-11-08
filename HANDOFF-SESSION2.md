# HANDOFF 2: state after the second Claude session (read this first, then HANDOFF.md)

Written on the Windows laptop where the bot is running. A new Claude on the other computer should read this file, then
`HANDOFF.md` (rules, code map, gotchas), then act. Humans are at HackUTD 2026 and short on time.

## Mission and clock
Win the Spacetime ScrabbleBot track. The live tournament is Saturday night, about 10:45-11 PM (it may already be running).
Our bot is TileHoarder (bot id 187), a TypeScript client of the SpacetimeDB database `scrabblebot` on
`https://maincloud.spacetimedb.com`. Repo: https://github.com/Aryan61056/tile-hoarders-scrabblebot (must stay public, branch `main`).

## What is running right now
- The bot runs on the **Windows laptop**, started with `BOT_NAME=TileHoarder TOURNAMENT_ID=2 npm run live`, registered for tournament 2.
- **Run the bot on ONE machine only.** If you want it on the other computer, stop it on the Windows laptop first (a human has to do that or
  say so), otherwise two copies fight over one bot slot. Do not start a second copy "to test".
- Tournament 2: status `registration` at last check, Vickrey, 6 bots per match, 4 Swiss rounds, top cut 6, then elimination (last place out),
  then a 3-game final decided by total score. Query the status without the CLI (the `spacetime` CLI is not installed on the laptop):
  `curl -s -X POST --data "SELECT id,status FROM tournament" https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql`
  (status is a variant index: 0 lobby, 1 swiss, 2 bracket, 3 final, 4 ended, 5 registration, 6 forceEnded).
- Healthy log lines: `m47217 r32 'R' bid 11 (bal 46, 45ms, recvLag 0ms, p90rtt 530ms, stale skipped 0)` and `ENDED score 90 balance 35`.
  Bids take about 45-50 ms. Trouble: recvLag over 1 s, repeated `reconnecting`, many scores of 0.

## What changed this session (all on `main` locally; PUSH MAY STILL BE PENDING)
Commits on top of `7c4d037`: log of floor experiment, clock-skew fix, merge of the phase-aware branch, new defaults, samples 64.
**The push to GitHub hung on a credential prompt (Git Credential Manager) and never completed**, so GitHub may still hold the old bot.
Check with `git fetch && git status` and `git log origin/main`. A human with GitHub signed in must run `git push origin main`.
If the other computer cannot see these commits, the files can also arrive through OneDrive (the project folder is under
`OneDrive/Documents/HackUTD/ScrambleBot`) or a copy.

Current defaults in `bot/src/core/ours.ts` (`DEFAULT_OURS`): `kappa 1.5`, `holdBal 40`, `samples 64` (earlier: 1.15 / 0 / 8).
Replay results (`bot/sim/replay.ts`, 600 matches per config, mean score +- 95% CI, field mean about 74):
| Change | Result |
|---|---|
| base before this session (kappa 1.15, holdBal 0, samples 8) | 76.3 +- 1.7 (seed 5), 76.8 (seed 11), 78.7 (seed 17) |
| with kappa 1.5 + holdBal 40 (samples 8), fresh seeds | 82.6 (seed 23), 82.5 (seed 31) |
| kappa 1.5 + holdBal 40 | +4.3 / +5.0 / +3.6 on seeds 5 / 11 / 17 (82.3 vs 78.7 on seed 17) |
| samples 8 -> 32 | 82.6 -> 86.1 (seed 23), 82.5 -> 84.9 (seed 31) |
| samples 8 -> 64 | 82.5 -> 86.2 (seed 31). 128 was not finished |
Live practice play on the kappa/holdBal defaults: 16 matches, mean about 79 (range 55-111). Top bots (ids 171, 193, 207) average 97-102.

Negative results, do not retry (all logged in `PLAN.md` section 6): an opening bid floor (`earlyFloor`: 59-75 vs 76.3), spend pacing
(`pace*` params: about 5 points worse, even quality-gated), cashing shorter words early (`playLen 6`: -10, `playReward 30`: -4),
round-dependent `pWin`/`kappa` ramps (about +1 at best), `beta`, `rho0`, `lateSpend`, `lateBoost`, `minBid` (flat or worse).
Lesson: tile COUNT is not the lever (floors and pacing raise tiles to 12-13 and lose points). Tile quality and valuation accuracy are.
More Monte Carlo samples (a more accurate marginal value) is the first thing that helped alone.

## Important bug fixed: local clock skew
The Windows laptop clock runs about 30 s ahead of the server. The bot skips auctions it thinks are already closed, so it never bid
(three matches scored 0 with balance 100). `bot/src/main.ts` now estimates the offset from the smallest recent receive lag
(`noteLag`, `clockSkewMs`) and uses it in the stale check. A machine with a correct clock is unaffected. If the bot ever scores 0
with no `bid` lines, check the clock first: `date -u` versus the `Date:` header of `curl -sI https://maincloud.spacetimedb.com`.

## Open branches (local only on the Windows laptop, not pushed)
- `worktree-agent-ae61b36f07ad6cabd`: the phase-aware branch, ALREADY MERGED into main (kappa/holdBal params, 3.6x word-plan speedup).
- `worktree-agent-af41d1a67bb8851f2`: spend-target (`pace*`) experiment, NOT merged, negative result. Do not merge.

## Ideas not yet tried (only if there is time, and only on replay)
- Test `samples` 96/128 and finer `kappa` (1.4-1.8) x `holdBal` (30-50) with samples 64. Confirm any gain on a fresh seed, e.g.
  `SIM_WORKERS=4 npx tsx sim/replay.ts '{"a":{},"b":{"samples":128}}' 600 41 all` (about 75 s per config at 8 samples, about 8x at 64).
- Tile-selection quality: the real gap to the top bots is probably in how the bot values letters/racks (`marginalValue`, `planValue`).
- Do NOT run heavy simulations while the tournament is running. Freeze the strategy before it starts.

## Running the bot / credentials
- The token is in `bot/.token-TileHoarder` (git-ignored). It was pasted into the Claude chat on the Windows laptop. Never print it, commit it,
  or put it in a URL. The other computer needs the file or `BOT_TOKEN`; ask the human. Rotate the token after the event.
- `cd bot && npm install` then `BOT_NAME=TileHoarder TOURNAMENT_ID=2 npm run live`. Run the replay set with `gunzip -k data/replay.jsonl.gz` first.
- The bot must be idle (in no match) when it starts and stay connected through the whole tournament. Keep the machine awake and on a stable network.

## Standing rules (from the humans)
Keep secrets out of the repo, chat and logs. Ask before downloading or installing anything beyond `npm install`. Do not reuse other
teams' code. Commit with clear messages and push to `main`, never force-push. Do not touch the humans' other (main track) project.
When you finish, update this file's state and say clearly whether the bot is running and where.
