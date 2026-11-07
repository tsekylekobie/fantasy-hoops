// Web Push: browser subscriptions (push_subscriptions, migration 0023) and
// sending to them. Keys come from the environment (README, "Injury alerts"):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  generated once: npx web-push generate-vapid-keys
//   VAPID_SUBJECT                        mailto:you@example.com (or the app's https URL)
// Without both keys, push is off: the menu hides the toggle and nothing is sent.
// The worker's injuries task calls notifyInjuryDowngrades after each sync.
import type { Pool, PoolClient } from "pg";
import webpush from "web-push";
import { CURRENT_SEASON } from "../types";
import { injuryAlert, isDowngrade, type PushMessage } from "./injuryAlerts";

type Db = Pool | PoolClient;

/** The public key browsers subscribe with, or null when push isn't configured. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()
    ? process.env.VAPID_PUBLIC_KEY.trim()
    : null;
}

function vapidSubject(): string {
  const s = process.env.VAPID_SUBJECT?.trim();
  if (s) return s;
  const app = process.env.APP_URL?.trim() || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  // Apple's push service rejects non-https, localhost subjects.
  return app.startsWith("https://") ? app : "mailto:fantasy-hoops@example.com";
}

let configured = false;
function configure(): boolean {
  const publicKey = vapidPublicKey();
  if (!publicKey) return false;
  if (!configured) {
    webpush.setVapidDetails(vapidSubject(), publicKey, process.env.VAPID_PRIVATE_KEY!.trim());
    configured = true;
  }
  return true;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A PushSubscription.toJSON() from the browser, or null when it isn't one. */
export function toBrowserSubscription(value: unknown): BrowserSubscription | null {
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!v || typeof v.endpoint !== "string" || !/^https:\/\//.test(v.endpoint) || v.endpoint.length > 2048) return null;
  const { p256dh, auth } = v.keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth) return null;
  if (p256dh.length > 256 || auth.length > 256) return null;
  return { endpoint: v.endpoint, keys: { p256dh, auth } };
}

/** Saves (or moves to this user) a browser's subscription. */
export async function saveSubscription(db: Db, userId: number, sub: BrowserSubscription, userAgent: string | null): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 512) ?? null],
  );
}

export async function deleteSubscription(db: Db, userId: number, endpoint: string): Promise<void> {
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, userId]);
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one message to each subscription; drops the ones the push service says are gone. Returns how many were delivered. */
async function sendAll(db: Db, subs: SubscriptionRow[], message: PushMessage): Promise<number> {
  if (!configure()) return 0;
  const payload = JSON.stringify(message);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        // TTL: a phone that's off for a day still gets it; older news isn't worth showing.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 24 * 60 * 60,
          urgency: "high",
          topic: message.tag.slice(0, 32),
        });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]);
        } else {
          console.error(`push to ${new URL(s.endpoint).host} failed (${status ?? "no status"})`, (err as Error).message);
        }
      }
    }),
  );
  return sent;
}

/** Sends to one saved subscription (e.g. the confirmation when a browser turns alerts on). */
export async function sendToSubscription(db: Db, endpoint: string, message: PushMessage): Promise<number> {
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = $1`,
    [endpoint],
  );
  return sendAll(db, rows, message);
}

/** One player's injury report change, as recorded by the worker (scripts/lib/upsert.ts recordInjuries). */
export interface InjuryChange {
  playerId: number;
  from: string | null;
  to: string | null;
  returnDate: string | null;
  description: string | null;
}

/**
 * Notifies the owner of each rostered player (this season's league) whose
 * status got worse. Returns how many notifications were delivered.
 */
export async function notifyInjuryDowngrades(db: Db, changes: InjuryChange[]): Promise<number> {
  if (!configure()) return 0;
  const worse = changes.filter((c) => c.to !== null && isDowngrade(c.from, c.to));
  if (!worse.length) return 0;
  const { rows } = await db.query<{
    player_id: number;
    player_name: string;
    team_name: string;
    user_id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `SELECT rp.player_id, p.first_name || ' ' || p.last_name AS player_name, ft.name AS team_name,
            ft.owner_user_id AS user_id, s.endpoint, s.p256dh, s.auth
       FROM roster_players rp
       JOIN leagues l ON l.id = rp.league_id AND l.season = $2
       JOIN fantasy_teams ft ON ft.id = rp.fantasy_team_id
       JOIN players p ON p.id = rp.player_id
       JOIN push_subscriptions s ON s.user_id = ft.owner_user_id
      WHERE rp.player_id = ANY($1)`,
    [worse.map((c) => c.playerId), CURRENT_SEASON],
  );
  const byPlayer = new Map(worse.map((c) => [c.playerId, c]));
  // One message per player and owner, sent to each of the owner's browsers.
  const groups = new Map<string, { message: PushMessage; subs: SubscriptionRow[] }>();
  for (const r of rows) {
    const key = `${r.player_id}:${r.user_id}`;
    let g = groups.get(key);
    if (!g) {
      const c = byPlayer.get(r.player_id)!;
      g = {
        message: injuryAlert({ ...c, to: c.to!, playerName: r.player_name, teamName: r.team_name }),
        subs: [],
      };
      groups.set(key, g);
    }
    g.subs.push(r);
  }
  let sent = 0;
  for (const g of groups.values()) sent += await sendAll(db, g.subs, g.message);
  return sent;
}
