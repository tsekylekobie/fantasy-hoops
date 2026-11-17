import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getLeagueSettings } from "@/lib/queries/settings";
import { CURRENT_SEASON } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import LeagueSettingsForm from "@/components/league/LeagueSettingsForm";
import styles from "@/components/league/LeagueSettings.module.css";

export const metadata: Metadata = { title: "League rules · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// The league's rules, read-only for every signed-in manager (they're set on Yahoo).
export default async function LeagueSettingsPage() {
  const session = await requireSignedInPage();
  const found = await getLeagueSettings(pool, CURRENT_SEASON, session.user.id);
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <Link href="/league" className={styles.back}>← League</Link>
        <h1 className={styles.title}>
          League rules
        </h1>
        {found && (
          <p className={styles.sub}>
            The league&rsquo;s rules as Yahoo has them, read-only. They change on Yahoo; the sync brings them here.
          </p>
        )}
        {!found ? (
          <p className={styles.empty}>No league for this season yet.</p>
        ) : (
          <LeagueSettingsForm initial={found.data} />
        )}
      </div>
    </div>
  );
}
