// Applies pending db/migrations/NNNN_name.sql files to DATABASE_URL, in order.
//   npm run db:migrate              # apply what's pending
//   npm run db:migrate -- --status  # list applied and pending, change nothing
//
// Each migration runs in its own transaction together with its row in
// schema_migrations, so a failure leaves nothing half-applied. Applied files
// are checksummed: editing one after it ran is an error. Change the schema by
// adding a new file instead.
import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const DIR = join(process.cwd(), "db/migrations");
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Any constant; keeps two deploys from migrating at once.
const LOCK_KEY = 727_031_001;

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return files.map((name) => {
    const m = NAME.exec(name);
    if (!m) throw new Error(`bad migration file name ${name}; expected NNNN_snake_case.sql`);
    if (seen.has(m[1])) throw new Error(`two migrations numbered ${m[1]}`);
    seen.add(m[1]);
    const sql = readFileSync(join(DIR, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const migrations = loadMigrations();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = new Set(migrations.map((m) => m.name));
    for (const name of applied.keys()) {
      if (!files.has(name)) throw new Error(`${name} was applied but its file is missing from db/migrations`);
    }
    for (const m of migrations) {
      const sum = applied.get(m.name);
      if (sum && sum !== m.checksum) {
        throw new Error(`${m.name} changed after it was applied; put the change in a new migration`);
      }
    }
    // A new file numbered below one already applied was probably a merge race.
    const lastApplied = migrations.filter((m) => applied.has(m.name)).at(-1)?.name ?? "";
    const pending = migrations.filter((m) => !applied.has(m.name));
    const outOfOrder = pending.filter((m) => m.name < lastApplied);
    if (outOfOrder.length > 0) {
      throw new Error(`${outOfOrder.map((m) => m.name).join(", ")} sorts before ${lastApplied}, which is already applied; renumber it`);
    }

    if (statusOnly) {
      for (const m of migrations) console.log(`${applied.has(m.name) ? "applied" : "pending"}  ${m.name}`);
      return;
    }
    if (pending.length === 0) {
      console.log("Schema is up to date.");
      return;
    }
    for (const m of pending) {
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${m.name} failed and was rolled back: ${(err as Error).message}`);
      }
      console.log(`Applied ${m.name}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
