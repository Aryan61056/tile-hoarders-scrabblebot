// Passive market-data dump. Connects with the saved bot token, reads the public
// tables once, writes them to data/market-dump.json and exits.
// It never joins a lobby, bids, or plays a word.
//
//   BOT_NAME=TileHoarder npx tsx src/dump.ts

import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const tokenPath = path.join(process.cwd(), `.token-${BOT_NAME}`);
const token = fs.readFileSync(tokenPath, "utf8").trim();
const outPath = path.join(process.cwd(), "data", "market-dump.json");

// JSON with bigint, timestamps and enum tags made readable.
function plain(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (x && typeof x === "object" && "microsSinceUnixEpoch" in x) {
        return Number((x as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch) / 1000;
      }
      if (x && typeof x === "object" && "__timestamp_micros_since_unix_epoch__" in x) {
        return Number((x as Record<string, bigint>).__timestamp_micros_since_unix_epoch__) / 1000;
      }
      if (x && typeof x === "object" && "tag" in x && Object.keys(x).length === 1) return x.tag;
      if (x && typeof x === "object" && "toHexString" in x) return (x as { toHexString(): string }).toHexString();
      return x;
    }),
  );
}

function rows(table: { iter(): Iterable<unknown> }) {
  return [...table.iter()].map(plain);
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(token)
  .onConnect((conn) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const db = conn.db;
        const dump = {
          takenAt: new Date().toISOString(),
          auctionResult: rows(db.auctionResult),
          auctionTopBidArchive: rows(db.auctionTopBidArchive),
          wordPlay: rows(db.wordPlay),
          matchState: rows(db.matchState),
          matchParticipant: rows(db.matchParticipant),
          bot: rows(db.bot),
          botStats: rows(db.botStats),
          matchmakerConfig: rows(db.matchmakerConfig),
          tournament: rows(db.tournament),
          tournamentMatch: rows(db.tournamentMatch),
        };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(dump));
        const counts = Object.fromEntries(
          Object.entries(dump).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]),
        );
        console.log("dumped", counts);
        process.exit(0);
      })
      .subscribeToAllTables();
  })
  .onConnectError((_c: ErrorContext, e: Error) => {
    console.error("connect error:", e.message);
    process.exit(1);
  })
  .build();
