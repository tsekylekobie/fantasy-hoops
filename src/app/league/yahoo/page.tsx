import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { CURRENT_SEASON } from "@/lib/types";
import { statusFor, yahooRole } from "@/lib/yahoo/connection";
import { REFRESH_MS, fetchUserLeagues } from "@/lib/yahoo/sync";
import SiteHeader from "@/components/SiteHeader";
import YahooRefresh from "@/components/yahoo/YahooRefresh";
import { Disconnect, PickLeague } from "@/components/yahoo/YahooConnectionActions";
import styles from "@/components/yahoo/YahooConnection.module.css";

export const metadata: Metadata = { title: "Yahoo connection · Fantasy Hoops" };
export const dynamic = "force-dynamic";

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET" : "—";

// The league plays on Yahoo; this app mirrors it read-only (src/lib/yahoo/sync.ts). The commissioner
// connects Yahoo here once; every manager can see how fresh the mirror is and refresh it.
export default async function YahooConnectionPage({ searchParams }: { searchParams: Promise<{ connected?: string }> }) {
  const session = await requireSignedInPage();
  const role = await yahooRole(pool, session.user.id);
  const { connected: justConnected } = await searchParams;
  const status = await statusFor(pool, role.admin);
  const { rows: [league] } = await pool.query<{ name: string; yahoo_league_key: string | null }>(
    `SELECT name, yahoo_league_key FROM leagues WHERE season = $1 ORDER BY id LIMIT 1`, [CURRENT_SEASON],
  );

  let leagues: { key: string; name: string }[] | null = null;
  let leaguesError: string | null = null;
  if (role.admin && status.connected && !status.leagueKey) {
    try {
      leagues = await fetchUserLeagues(pool);
    } catch (err) {
      leaguesError = (err as Error).message;
    }
  }
  const minutes = Math.round(REFRESH_MS / 60_000);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <Link href="/league" className={styles.back}>← League</Link>
        <h1 className={styles.title}>Yahoo connection</h1>
        <p className={styles.sub}>
          The league is played on Yahoo; this app mirrors it read-only: rosters and moves every {minutes} minutes,
          this week&rsquo;s scores every hour, settings, standings and finished weeks daily.
        </p>

        {!role.member ? (
          <p className={styles.sub}>You&rsquo;re not in this league.</p>
        ) : (
          <section className={styles.card}>
            <h2>Status</h2>
            <dl className={styles.facts}>
              <dt>Connection</dt>
              <dd>
                {status.connected ? <span className={styles.ok}>Connected</span> : <span className={styles.bad}>Not connected</span>}
                {status.connected && status.connectedBy && ` by ${status.connectedBy}, ${fmt(status.connectedAt)}`}
              </dd>
              <dt>Yahoo league</dt>
              <dd>{status.leagueKey ?? "Not chosen yet"}{league && status.leagueKey && league.yahoo_league_key === status.leagueKey ? ` (${league.name})` : ""}</dd>
              <dt>Last update</dt>
              <dd>{fmt(status.lastRefreshAt)}</dd>
              {status.lastError && (
                <>
                  <dt>Last problem</dt>
                  <dd className={styles.bad}>{status.lastError} <small>({fmt(status.lastErrorAt)})</small></dd>
                </>
              )}
              {status.throttledUntil && (
                <>
                  <dt>Paused</dt>
                  <dd>Yahoo asked us to slow down; next try after {fmt(status.throttledUntil)}.</dd>
                </>
              )}
            </dl>
            {status.connected && status.leagueKey && <YahooRefresh />}
            {justConnected && status.connected && (
              <p className={styles.note}>
                Connected. {status.leagueKey ? "The first sync runs within a few minutes, or press Refresh." : "Now choose the league to mirror."}
              </p>
            )}
          </section>
        )}

        {leagues && (
          <section className={styles.card}>
            <h2>Choose the league</h2>
            {leagues.length === 0 ? (
              <p className={styles.note}>
                This Yahoo account has no {CURRENT_SEASON}-{(CURRENT_SEASON + 1) % 100} NBA league. Reconnect with the
                commissioner&rsquo;s Yahoo account.
              </p>
            ) : (
              <PickLeague leagues={leagues} />
            )}
          </section>
        )}
        {leaguesError && <p className={styles.error}>Couldn&rsquo;t list the account&rsquo;s leagues: {leaguesError}</p>}

        {role.admin && (
          <section className={styles.card}>
            <h2>{status.connected ? "Reconnect" : "Connect"}</h2>
            {!status.configured ? (
              <p className={styles.note}>
                Yahoo isn&rsquo;t set up on this server yet: set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_TOKEN_KEY
                (README, &ldquo;Connecting Yahoo&rdquo;).
              </p>
            ) : (
              <>
                <p className={styles.note}>
                  {status.connected
                    ? "Reconnect if the last problem says the connection stopped working. Use a Yahoo account in the league (yours)."
                    : "Sign in to Yahoo with your account in the league and allow read access to Fantasy Sports. This is only a data connection: everyone keeps signing in here with Google."}
                </p>
                <div className={styles.actions}>
                  <a className={styles.button} href="/api/yahoo/connect">{status.connected ? "Reconnect Yahoo" : "Connect Yahoo"}</a>
                  {status.connected && <Disconnect />}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
