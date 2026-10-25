// The League page's waiver order: who gets the first claim at the next waiver
// run, each team's pending claim count, and the league's waiver rules.
import Link from "next/link";
import { fmtWaiverTime } from "@/components/players/format";
import type { WaiverOrder as Data } from "@/lib/types";
import styles from "./WaiverOrder.module.css";

const TYPE_TEXT: Record<Data["type"], string> = {
  continual_rolling: "Continual rolling: a team that wins a claim moves to the back.",
  reverse_standings: "Reverse standings: the worst record claims first.",
  faab: "FAAB bidding isn’t built yet, so claims go by this order and a win moves a team to the back.",
};

export default function WaiverOrder({ data, myTeamId }: { data: Data | null; myTeamId: number | null }) {
  if (!data) return null;
  const next = fmtWaiverTime(data.nextRunAt, data.timeZone, "long");
  return (
    <section className={styles.card} aria-labelledby="waiver-order-heading">
      <h3 id="waiver-order-heading">Waiver order</h3>
      <p className={styles.sub}>
        Waivers run daily at {next.split(" · ")[1]}. Next run {next.split(" · ")[0]}.
      </p>
      <ol className={styles.list}>
        {data.teams.map((t) => (
          <li key={t.id} className={t.id === myTeamId ? styles.mine : undefined}>
            <span className={styles.n}>{t.priority}</span>
            <i aria-hidden="true">{t.abbreviation}</i>
            <Link href={t.id === myTeamId ? "/my-team" : `/team/${t.id}`}>{t.name}</Link>
            {t.pendingClaims > 0 && (
              <span className={styles.claims} title="Pending claims">
                {t.pendingClaims} claim{t.pendingClaims === 1 ? "" : "s"}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className={styles.foot}>
        {TYPE_TEXT[data.type]} Dropped players stay on waivers for {data.waiverDays} day{data.waiverDays === 1 ? "" : "s"}
        {data.waiversAfterGameStart && ", and free agents go on waivers once their game starts"}.
      </p>
    </section>
  );
}
