import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getLeagueSettings } from "@/lib/queries/settings";
import { CURRENT_SEASON } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import LeagueSettingsForm from "@/components/league/LeagueSettingsForm";
import styles from "@/components/league/LeagueSettings.module.css";

export const metadata: Metadata = { title: "League settings · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Commissioner only: the league's rules, saved through PUT /api/league/settings.
export default async function LeagueSettingsPage() {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  const found = session ? await getLeagueSettings(pool, CURRENT_SEASON, session.user.id) : null;
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <Link href="/league" className={styles.back}>← League</Link>
        <h1 className={styles.title}>League settings</h1>
        {!session ? (
          <p className={styles.empty}>Sign in to see league settings.</p>
        ) : !found ? (
          <p className={styles.empty}>No league for this season yet.</p>
        ) : !found.isCommissioner ? (
          <p className={styles.empty}>Only the commissioner can change league settings.</p>
        ) : (
          <LeagueSettingsForm initial={found.data} />
        )}
      </div>
    </div>
  );
}
