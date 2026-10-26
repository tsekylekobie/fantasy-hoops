// Game limits on My team: the week's starter games against the league's caps
// (TeamLineupResponse.gameLimits, lineup/gameLimits.ts), the total and each
// capped slot, with a warning for days whose starts won't count.
import type { GameLimitCount, GameLimitUsage } from "@/lib/types";
import styles from "./GameLimits.module.css";

const weekday = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

/** "Thu’s", "Thu’s and Fri’s", "Wed’s, Thu’s and Fri’s". */
function days(list: string[]): string {
  const names = list.map((d) => `${weekday(d)}’s`);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function Row({ label, count, what }: { label: string; count: GameLimitCount; what: string }) {
  const full = count.used >= count.limit;
  const width = count.limit > 0 ? Math.min(100, (count.used / count.limit) * 100) : 100;
  const blocked = count.blockedDays.length > 0;
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <b className={styles.count}>{count.used} / {count.limit}</b>
      <div className={`${styles.bar} ${full ? styles.full : ""}`} aria-hidden="true">
        <i style={{ width: `${width}%` }} />
      </div>
      {blocked ? (
        <em className={styles.warn}>
          {full ? "At limit" : "Over the limit"}: {days(count.blockedDays)} {what} won’t count
        </em>
      ) : count.planned > count.used && (
        <span className={styles.planned}>{count.planned} with your lineup as set</span>
      )}
    </div>
  );
}

export default function GameLimits({ usage, week }: { usage: GameLimitUsage; week: number | null }) {
  return (
    <section className={styles.panel} aria-label="Game limits">
      <Row label={week === null ? "Games" : `Week ${week} games`} count={usage.total} what="starts" />
      {usage.slots.map((s) => <Row key={s.slot} label={s.slot} count={s} what={`${s.slot} starts`} />)}
    </section>
  );
}
