// Re-fetch the raw BALLDONTLIE sample responses in data/samples/.
// Usage: npm run fetch:samples [-- --date 2026-10-23] [--out data/samples]
// Needs BALLDONTLIE_API_KEY (and optionally BALLDONTLIE_BASE_URL) in .env.
// Stays far under any rate limit (5 requests, 1.5 s apart).
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const date = opt("date", "2026-10-23");
const outDir = opt("out", "data/samples");

const key = process.env.BALLDONTLIE_API_KEY;
if (!key) {
  console.error("BALLDONTLIE_API_KEY is not set (see .env.example)");
  process.exit(1);
}
const base = (process.env.BALLDONTLIE_BASE_URL || "https://api.balldontlie.io/v1").replace(/\/+$/, "");

const requests = [
  ["teams.json", "/teams"],
  ["players.json", "/players?per_page=25"],
  [`games-${date}.json`, `/games?dates[]=${date}&per_page=100`],
  [`stats-${date}.json`, `/stats?dates[]=${date}&per_page=100`],
  ["player_injuries.json", "/player_injuries?per_page=100"],
];

mkdirSync(outDir, { recursive: true });
for (const [file, path] of requests) {
  const res = await fetch(base + path, { headers: { Authorization: key } });
  const body = await res.text();
  if (!res.ok) {
    console.error(`${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
    process.exitCode = 1;
  } else {
    writeFileSync(join(outDir, file), body); // raw body, unmodified
    console.log(`${path} -> ${join(outDir, file)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
