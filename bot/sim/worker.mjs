// Bootstraps tsx inside a worker thread, then runs the TypeScript worker entry
// (par.ts by default, or workerData.entry).
import { register } from "tsx/esm/api";
import { workerData } from "node:worker_threads";
register();
await import(workerData?.entry ?? "./par.ts");
