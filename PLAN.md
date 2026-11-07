# ScrabbleBot: plan to win

Source of truth for the rules: https://github.com/clockworklabs/scrabblebot
(`docs/bot-guide.md`, `spacetimedb/src/game.ts`, `spacetimedb/src/letters.ts`, `bot-starter/`).
Everything below was read from that repo, not guessed. Numbers marked (hypothesis) need the simulator to confirm.

## 1. What the game really is

- 98-tile standard bag, no blanks. Each bot starts with 5 private tiles and 100 coins.
- One tile is auctioned per round, 1-second sealed bid. **Vickrey by default**: the winner pays the
  second-highest bid (1 if nobody else bid). First-price is configurable, so read `match_state.auctionType` at runtime.
- Playing a word is instant, consumes the tiles, and pays `base x multiplier`:
  1x for 3 letters or fewer, 1.5x at 4, 2x at 5, 2.5x at 6, **3x at 7+**. Words must be in ENABLE, min 2 letters.
- Reward goes into both `balance` and `score`. **Only `score` ranks bots. Coins are only a means to buy tiles.**
- Match ends when the bag is empty. Tiles left in your rack at the end are worth 0.
- **Match length is fixed.** `closeAuction` draws the next tile up front and never returns an unbid tile to the bag
  (the README is stale on this). So a match has exactly `98 - matchSize x startingRackSize` auctions: 68 with the defaults,
  about 68 seconds. Rounds left, counting the open auction, is `bagTotal + 1`.
- Public info: every auction result (letter, winner, price paid), every word played, `bagTotal`, `auctionType`,
  `startingRackSize`, `auctionDurationMs`. Private: opponents' racks, but they are derivable.
  Winning bids (`top_bid`) are hidden from bots during the match.
- Tournament: Swiss rounds (scored by finishing place), top-N cut, single elimination (last place out),
  then 3 final games decided by total score. Lobby matches run continuously for practice.

## 2. Where the edge is

1. **Long words dominate.** The bag averages 1.91 points per tile. In a 7+ letter word each tile is worth about 5.7 coins.
   A Z, Q, J or X inside a 7+ word is worth 24-30 on its own. The starter bot plays the longest word it can the instant
   any word exists, so it cashes out at 1x-1.5x. Hoarding for 7-8 letter words is the biggest structural edge.
2. **CORRECTED by live data: tiles are NOT cheap.** The first 38 live auctions we observed (other teams' matches, 2026-11-07)
   cleared at a **median of 9 coins**, mean 10.5. Vowels and common consonants (A, E, I, O, T, N, R) sold for 6-12 coins,
   H/C/M/P/Y/F/V for 13-19, J 25, X 29. Face value is 1-4, so the field already bids about 7x face. With 100 coins a bot
   buys roughly 10 tiles, so **coins are a binding constraint** and the plan must price them: bid
   `min(true marginal value, value-per-coin threshold)` and keep a cash reserve. Words are the only income, so the
   timing of cash-out plays matters a lot. Re-derive the opponent pool in the simulator from this data, not from face-value bidders.
3. **Bid the true marginal value of the tile.** Value = E[best word-plan score with the tile] minus E[without it],
   where the future tiles are sampled from the unseen pool (98 minus my start rack minus every auctioned letter).
   Under Vickrey truthful bidding is never worse than shading.
4. **Coins recycle and have zero terminal value.** Spend them: play a word to refund cash when you need to bid,
   and in the last ~10 rounds spend down. Optional: bid to deny a rival a tile they value when coins are surplus
   (you pay their bid in coins, not score).
5. **Endgame rules.** The last auction's tile can never be played (the match ends in the same transaction), so bid 0.
   The tile won in the second-to-last auction must be played within about 1 second. Dump the rack when `bagTotal <= 1`.
6. **Speed and uptime.** An offline or late bot loses every auction. Submit a fast safe bid immediately (bids replace),
   then refine if the heavy computation finishes in time.
7. **Read config at runtime** (`auctionType`, `startingRackSize`, `auctionDurationMs`, match size). Do not hardcode.
8. **The objective changes by phase.** Swiss is scored by finishing place, elimination only removes last place, and the
   final is total score over 3 games. A high-variance hoarder that sometimes busts is fine in Swiss and deadly in
   elimination. The bot can see the phase (`tournamentMatch.phase` for its `matchId`) and should switch risk settings:
   in elimination use a lower hoard threshold and an earlier cash-out (minimize P(last)); in the final maximize expected score.
9. **Endgame dump must be a burst.** The starter plays one word per rack change with a 500 ms throttle, so in the last
   ~1 s window it can drop words. When `bagTotal == 0` (last auction open), compute the full rack partition and fire every
   `submitWord` back to back. Do the same for any mid-game cash-out that plays several words.

## 2b. What 25,720 real matches say (dumped from the live DB, Cal Hacks history; `tools/analyze*.py`)

- Every match: Vickrey, 5 start tiles, 1000 ms auctions, 6 bots, 68 auctions. The one tournament ran 4 Swiss rounds, top-6 cut.
- Only the 17,048 all-human matches are a fair benchmark. Matches padded with idle sim bots flatter the bots in them
  (that is why "Bron" and "LUCENT" top the raw leaderboard).
- All-human benchmark: field mean score 73.7, match winner mean 108.6, 2nd place 91.5. Best bots average 90-102 and win 30-50%.
- Median price paid 12 coins (Z 38, X 31, J 29, Q 27, K 24, Y/H 21, common vowels about 10). Flat through the match.
- **Score is about 5.5 points per tile won**, roughly linear (12 tiles 78, 16 tiles 101, 20 tiles 120). Top bots win about the
  same number of tiles at the same price as everyone else. They convert tiles to points better (more 7-letter words).
- 38% of all words played are exactly 7 letters: the 3x multiplier is already reached at 7, so 8+ letters adds only linear value.
- Weak bots end the match holding 50-100 unspent coins. Top bots spend down to about 15-20.
- The upstream starter bot scores about 15 and finishes last 96% of the time in the calibrated simulator.

## 2c. Simulator results (bot/sim, calibrated to the numbers above; opponents do not adapt, so treat as optimistic)

| Bot | Score | Field | Mean place | Win% |
|---|---|---|---|---|
| upstream starter | 15 | 77 | 5.9 | 0% |
| calibrated field clone | 69 | 67 | 3.5 | 19% |
| ours, kappa 2.4 (overpays) | 68 | 69 | 3.5 | 11% |
| ours, kappa 1.6 | 90 | 67 | 2.3 | 38% |
| ours, kappa 1.3 + budget-aware bids (beta 1) | 103 | 64 | 1.7 | 60% |

The unlock is budget-aware bidding: loosen the bid factor when coins per remaining round are high, so we never end with
unspent cash. Live validation against real bots is still required.

## 3. Build plan (about 7 hours to the 10:45 PM live event; adjust to the real clock)

### Phase 0, setup (30-45 min)
- Clone `clockworklabs/scrabblebot`, copy `bot-starter/` in, `npm install && npm run generate`.
- Link the spacetimedb.com identity at `/account`, create a team at `/team/new`, generate a token (shown once).
- Put `.token-*`, `.env*` in `.gitignore` **before the first commit**. Create the public GitHub repo now (required to win).
- Run the unmodified starter in a live lobby to confirm the pipeline works.
- Skim public bots from Cal Hacks 13 for ideas only; do not copy code.

### Phase 1, local simulator (1-1.5 h)
- Reimplement the engine from `game.ts` (auction close, Vickrey payment, `playWord`, reward table, draw from bag) as a fast
  in-process TypeScript sim: thousands of matches per minute.
- Opponent pool: starter default, module sims (Cheapskate, ValueBidder, Aggressive), face-value x k bidders,
  hoarders, and our own previous versions.
- Calibrate opponents with real data where possible: ended matches expose `auctionResult`, `wordPlay` and the public
  `auctionTopBidArchive` (real top bids), and the live DB may still hold Cal Hacks history. Fit per-letter opponent
  valuations from that instead of inventing them. The leaderboard shows which bots actually win.
- Metrics: mean score, mean place, **P(last) and P(1st)**, win rate over 5k+ matches. Report ranges, not single runs.
  Evaluate separately for the Swiss objective (mean place), elimination (P(last)) and the final (mean total score).

### Phase 2, word engine (45 min)
- Load the ENABLE wordlist once into typed arrays grouped by length with letter-count vectors.
- `bestPlan(rack)`: best partition of the rack into words maximizing total reward (greedy plus local search is enough).
- Budget about 50 ms per call. Unit-test against known racks.

### Phase 3, valuation and policy (1.5-2 h)
- `decideBid`: Monte Carlo marginal value with common random numbers, capped by cash minus a small reserve.
  First-price branch: shade using observed `paid` history by letter.
- `chooseWord`: do not play short words early. Play when (a) a 7+ word is available, (b) cash is needed for a valuable bid,
  (c) the endgame dump window opens, (d) a rack-risk rule fires (for example rack too large for the rounds left).
- Tune the few parameters (reserve, hoard threshold, rollout count, dump timing) by simulator search.
- If rollouts are too slow, distill them into a lookup table built offline from self-play.

### Phase 4, live validation and hardening (1 h)
- Run in real lobbies. Compare real results against the simulator. If they disagree, trust the live results and fix the sim.
- Reconnect with backoff, watchdog, rejoin lobby after each match, never crash on a failed reducer call.
- Run it on a stable network (wired, or a cloud VM). Venue Wi-Fi is the biggest uptime risk.
- Smoke test `TOURNAMENT_ID` registration with a dummy tournament if the admins allow it.

### Phase 5, freeze and tournament (final hour)
- Freeze strategy about 60 min before the event. Only fix crashes after that.
- Register for the tournament as soon as it opens. Be idle (not mid-match) when it starts.
- Keep the process connected for all Swiss rounds, elimination and finals. Watch logs.

## 4. Things to verify early (rules I could not settle from the code)

- Tournament `auctionType` (Vickrey or first-price) and match size.
- Lobby timer: README says 60 s, code says 90 s. Irrelevant to strategy, but confirm.
- Any rule changes since Cal Hacks. Ask at the Spacetime booth.

## 5. Risks

- Strong opposing teams will also hoard and bid true value, which raises second prices. The simulator must include such opponents.
- The final is 3 games of a 6-player match, so some luck remains. The edge is in consistently finishing top-2.
- Token leak: never commit it, never paste it in a public place.
- CPU stalls: the starter warns that a slow `chooseWord` blocks the bot. Keep per-event work under about 100 ms or use a worker thread.
