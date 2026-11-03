import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedInPage } from "@/lib/auth/viewer";
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
  const session = await requireSignedInPage();
  const found = await getLeagueSettings(pool, CURRENT_SEASON, session.user.id);
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <Link href="/league" className={styles.back}>← League</Link>
        <h1 className={styles.title}>
          League settings{found?.isCommissioner && <small className={styles.pill}>COMMISSIONER</small>}
        </h1>
        {found?.isCommissioner && (
          <p className={styles.sub}>
            Only you can change these. A change applies from the next action on: lineups already locked and moves already
            processed stay as they were. Managers see the rules read-only on the League page.
          </p>
        )}
        {!found ? (
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
