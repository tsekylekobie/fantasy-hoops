// League membership by email (league_members, db/migrations/0017_yahoo_import.sql).
// An imported league lists each manager's Google email; signing in with it
// gives the user that team, and the commissioner seat if marked.
import type { Pool, PoolClient } from "pg";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The key two addresses for one mailbox share: lowercased, and for Gmail without
 * dots or a "+tag" in the name and with googlemail.com as gmail.com. Gmail ignores
 * those, so a commissioner may list "warrenwwang@gmail.com" for an account Google
 * reports as "warren.w.wang@gmail.com". Other domains only lowercase.
 */
export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  const domain = e.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return e;
  const name = e.slice(0, at).split("+")[0].replaceAll(".", "");
  return `${name}@gmail.com`;
}

/**
 * Links `userId` to every team listed for `email` (or another spelling of the same
 * mailbox, `canonicalEmail`) that has no owner yet, and makes them commissioner where
 * marked and the seat is empty. Returns teams linked.
 */
export async function linkMemberships(db: Pool | PoolClient, userId: number, email: string): Promise<number> {
  const key = canonicalEmail(email);
  const { rows } = await db.query<{ email: string }>(`SELECT DISTINCT email FROM league_members`);
  const listed = rows.map((r) => r.email).filter((e) => canonicalEmail(e) === key);
  if (listed.length === 0) return 0;

  const { rowCount } = await db.query(
    `UPDATE fantasy_teams ft SET owner_user_id = $1
       FROM league_members m
      WHERE m.email = ANY($2::text[]) AND ft.id = m.fantasy_team_id AND ft.owner_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fantasy_teams o WHERE o.league_id = ft.league_id AND o.owner_user_id = $1)`,
    [userId, listed],
  );
  await db.query(
    `UPDATE leagues l SET commissioner_user_id = $1
       FROM league_members m
      WHERE m.league_id = l.id AND m.email = ANY($2::text[]) AND m.is_commissioner AND l.commissioner_user_id IS NULL`,
    [userId, listed],
  );
  return rowCount ?? 0;
}
