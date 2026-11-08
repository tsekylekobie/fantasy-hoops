import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedInPage } from "@/lib/auth/viewer";
import { pool } from "@/lib/db";
import { getRecentTransactions } from "@/lib/queries/league";
import { CURRENT_SEASON } from "@/lib/types";
import SiteHeader from "@/components/SiteHeader";
import RecentTransactions from "@/components/league/RecentTransactions";
import styles from "@/components/league/LeagueSettings.module.css";
import txStyles from "@/components/league/RecentTransactions.module.css";

export const metadata: Metadata = { title: "Transactions · Fantasy Hoops" };
export const dynamic = "force-dynamic";

const PER_PAGE = 50;

// Every completed transaction this season, newest first, PER_PAGE at a time (?page=N); the League page's Recent
// transactions links here. Waiver claims read as one report per run, as there.
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireSignedInPage();
  const asked = Number((await searchParams).page);
  const page = Number.isInteger(asked) && asked > 0 ? asked : 1;
  const data = await getRecentTransactions(pool, CURRENT_SEASON, {
    limit: PER_PAGE, offset: (page - 1) * PER_PAGE, userId: session.user.id,
  });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PER_PAGE));
  const href = (n: number) => (n === 1 ? "/league/transactions" : `/league/transactions?page=${n}`);
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <SiteHeader />
        <Link href="/league" className={styles.back}>← League</Link>
        <h1 className={styles.title}>Transactions</h1>
        {!data ? (
          <p className={styles.empty}>No league for this season yet.</p>
        ) : (
          <RecentTransactions
            data={data}
            myTeamId={data.myTeamId}
            title={`All transactions · ${data.total}`}
            footer={pages > 1 && (
              <nav className={txStyles.pager} aria-label="Pages">
                <span>{page > 1 && <Link href={href(Math.min(page - 1, pages))}>← Newer</Link>}</span>
                <span>Page {Math.min(page, pages)} of {pages}</span>
                <span>{page < pages && <Link href={href(page + 1)}>Older →</Link>}</span>
              </nav>
            )}
          />
        )}
      </div>
    </div>
  );
}
