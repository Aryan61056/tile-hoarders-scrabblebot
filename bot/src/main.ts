// Live ScrabbleBot client using our strategy core (src/core).
//
//   BOT_NAME=TileHoarder npm run live                 # token read from .token-<BOT_NAME>
//   BOT_NAME=TileHoarder TOURNAMENT_ID=2 npm run live # also registers for a tournament
//   PARAMS='{"kappa":1.2}' ...                        # override strategy params
//
// Differences from the starter: narrow subscriptions (the starter's subscribeToAllTables pulls
// ~1.7M rows of history and takes ~40 s), per-match unseen-tile tracking, auto-reconnect,
// and a burst word dump in the final auction window.

import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import type { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dict, planWords } from "./core/words.js";
import { BidState, DEFAULT_OURS, OurParams, ourBid, ourWords } from "./core/ours.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const PARAMS: OurParams = { ...DEFAULT_OURS, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) };
const BID_BUDGET_MS = Number(process.env.BID_BUDGET_MS ?? 250);

const BAG = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

const dict = new Dict(path.join(process.cwd(), "data", "wordlist.txt"));
const rng = Math.random;
void planWords;

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}] [${BOT_NAME}]`, ...a);
const warn = (what: string) => (err: unknown) =>
  log(`${what} failed: ${err instanceof Error ? err.message : err}`);

let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let reconnectDelay = 1000;
const subscribedMatches = new Set<string>();
const bidDone = new Set<string>();
const lastWordAttempt = new Map<string, number>();
const dumpedAuction = new Set<string>();
const finished = new Set<string>();

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function letterIdx(l: string): number {
  return l.charCodeAt(0) - 65;
}

// ---------- reading state ----------

function myRack(c: DbConnection, matchId: bigint): Int8Array {
  const rack = new Int8Array(26);
  for (const h of c.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const i = letterIdx(h.letter);
    if (i >= 0 && i < 26) rack[i]! += h.count;
  }
  return rack;
}

function myParticipant(c: DbConnection, matchId: bigint) {
  if (myBotId === null) return null;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId) return p;
  }
  return null;
}

// Letters we have not seen: bag minus every auctioned letter (public) minus our own start tiles.
// Our start tiles = current rack + letters we played - letters we won.
function unseenFor(c: DbConnection, matchId: bigint, rack: Int8Array): Int8Array {
  const seen = new Int8Array(26);
  for (const a of c.db.auction.iter()) {
    if (a.matchId === matchId) seen[letterIdx(a.letter)]!++;
  }
  const start = Int8Array.from(rack);
  for (const w of c.db.wordPlay.iter()) {
    if (w.matchId !== matchId || w.botId !== myBotId) continue;
    for (const ch of w.word) start[letterIdx(ch)]!++;
  }
  for (const r of c.db.auctionResult.iter()) {
    if (r.matchId === matchId && r.winnerBotId === myBotId) start[letterIdx(r.letter)]!--;
  }
  const unseen = new Int8Array(26);
  for (let i = 0; i < 26; i++) unseen[i] = Math.max(0, BAG[i]! - seen[i]! - Math.max(0, start[i]!));
  return unseen;
}

// ---------- subscriptions ----------

function ensureMatchSubscription(c: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (subscribedMatches.has(key)) return;
  subscribedMatches.add(key);
  c.subscriptionBuilder()
    .onApplied(() => {
      // catch an auction that was already open when the subscription landed
      for (const a of c.db.auction.iter()) {
        if (a.matchId === matchId && a.status.tag === "Open") onAuction(c, a.id, a.matchId, a.letter);
      }
    })
    .subscribe([
      `SELECT * FROM auction WHERE match_id = ${key}`,
      `SELECT * FROM auction_result WHERE match_id = ${key}`,
      `SELECT * FROM word_play WHERE match_id = ${key}`,
    ]);
}

function refreshMatches(c: DbConnection) {
  if (myBotId === null) return;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = c.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") ensureMatchSubscription(c, p.matchId);
  }
}

function inRunningMatch(c: DbConnection): boolean {
  if (myBotId === null) return false;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    if (c.db.matchState.id.find(p.matchId)?.status.tag === "Running") return true;
  }
  return false;
}

let lobbyTimer: ReturnType<typeof setInterval> | null = null;
function startLobbyLoop(c: DbConnection) {
  if (lobbyTimer) clearInterval(lobbyTimer);
  const tick = () => {
    if (myBotId === null || inRunningMatch(c)) return;
    c.reducers.joinLobby({}).catch(() => {
      /* expected while in a tournament or a running match */
    });
  };
  tick();
  lobbyTimer = setInterval(tick, 4000);
}

// ---------- decisions ----------

function onAuction(c: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidDone.has(key)) return;
  const m = c.db.matchState.id.find(matchId);
  const me = myParticipant(c, matchId);
  if (!m || m.status.tag !== "Running" || !me) return;
  bidDone.add(key);
  const t0 = Date.now();
  const rack = myRack(c, matchId);
  const state: BidState = {
    letter: letterIdx(letter),
    roundsLeft: m.bagTotal + 1,
    balance: Number(me.balance),
    rack,
    unseen: unseenFor(c, matchId, rack),
  };
  const amount = ourBid(PARAMS, dict, state, rng, BID_BUDGET_MS);
  if (amount > 0) {
    c.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(warn(`bid ${amount} on ${letter}`));
  }
  log(
    `m${matchId} r${state.roundsLeft} '${letter}' bid ${amount} (bal ${state.balance}, ${Date.now() - t0}ms)`,
  );
  playWords(c, matchId, `${matchId}:${auctionId}`);
}

function playWords(c: DbConnection, matchId: bigint, tag: string) {
  const m = c.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const auctionsLeft = m.bagTotal + 1;
  const dumping = auctionsLeft <= PARAMS.dumpAt;
  const now = Date.now();
  const k = String(matchId);
  if (dumping) {
    if (dumpedAuction.has(tag)) return; // one burst per auction window
    dumpedAuction.add(tag);
  } else if (now - (lastWordAttempt.get(k) ?? 0) < 300) {
    return;
  }
  lastWordAttempt.set(k, now);
  const rack = myRack(c, matchId);
  const me = myParticipant(c, matchId);
  const idxs = ourWords(PARAMS, dict, rack, auctionsLeft, me ? Number(me.balance) : Infinity);
  for (const i of idxs) {
    const word = dict.words[i]!;
    log(`m${matchId} play ${word}${dumping ? " (dump)" : ""}`);
    c.reducers.submitWord({ matchId, word }).catch(warn(`play ${word}`));
  }
}

// ---------- connection ----------

function onMatchEnded(c: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (finished.has(key)) return;
  const me = myParticipant(c, matchId);
  if (!me) return;
  finished.add(key);
  log(`m${matchId} ENDED score ${me.score} balance ${me.balance}`);
}

function connect() {
  const token = process.env.BOT_TOKEN ?? loadToken();
  log(`connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(token)
    .onConnect((c, identity, tok) => {
      conn = c;
      myIdentity = identity;
      subscribedMatches.clear();
      fs.writeFileSync(TOKEN_PATH, tok);
      log(`connected as ${identity.toHexString().slice(0, 12)}…`);

      c.db.auction.onInsert((_ctx, a) => {
        if (a.status.tag === "Open") onAuction(c, a.id, a.matchId, a.letter);
      });
      c.db.myRack.onInsert(() => {
        for (const p of c.db.matchParticipant.iter()) {
          if (p.botId === myBotId && c.db.matchState.id.find(p.matchId)?.status.tag === "Running")
            playWords(c, p.matchId, `rack:${Date.now()}`);
        }
      });
      c.db.matchState.onInsert(() => refreshMatches(c));
      c.db.matchState.onUpdate((_ctx, old, neu) => {
        refreshMatches(c);
        if (old.status.tag !== "Ended" && neu.status.tag === "Ended") onMatchEnded(c, neu.id);
      });
      c.db.matchParticipant.onInsert(() => refreshMatches(c));

      c.subscriptionBuilder()
        .onApplied(() => {
          const cred = c.db.botCredential.identity.find(identity);
          myBotId = cred ? cred.botId : null;
          if (myBotId === null) {
            log("no bot credential for this token — run with a valid token/nonce");
            process.exit(1);
          }
          log(`acting as bot ${myBotId}`);
          // our own participation rows (hundreds), not everyone's history
          c.subscriptionBuilder()
            .onApplied(() => {
              refreshMatches(c);
              startLobbyLoop(c);
              if (TOURNAMENT_ID) {
                c.reducers
                  .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
                  .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
                  .catch(warn("tournament registration"));
              }
              reconnectDelay = 1000;
              log("ready");
            })
            .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
        })
        .subscribe([
          "SELECT * FROM bot_credential",
          "SELECT * FROM match_state",
          "SELECT * FROM my_rack",
        ]);
    })
    .onConnectError((_c: ErrorContext, err: Error) => {
      log("connect error:", err.message);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      log("disconnected");
      scheduleReconnect();
    })
    .build();
}

function scheduleReconnect() {
  if (lobbyTimer) clearInterval(lobbyTimer);
  lobbyTimer = null;
  myBotId = null;
  const d = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  log(`reconnecting in ${d}ms`);
  setTimeout(connect, d);
}

void myIdentity;
void conn;
connect();
