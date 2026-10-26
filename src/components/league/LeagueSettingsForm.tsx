"use client";

// /league/settings: the commissioner's form for the league's rules (Yahoo's
// Commissioner > Edit League Settings). Saves the whole form at once with
// PUT /api/league/settings and shows the next waiver run on the saved schedule.
import { useState, type ReactNode } from "react";
import { fmtGameDate, fmtWaiverDays, fmtWaiverTime } from "@/components/players/format";
import { bracketRounds } from "@/lib/playoffs/bracket";
import { INJURY_STATUSES, type LeagueSettings, type LeagueSettingsResponse } from "@/lib/types";
import styles from "./LeagueSettings.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TIME_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "UTC",
];

const WAIVER_TYPES: { value: LeagueSettings["waiverType"]; label: string }[] = [
  { value: "continual_rolling", label: "Continual rolling" },
  { value: "reverse_standings", label: "Reverse standings" },
  { value: "faab", label: "FAAB (blind bidding)" },
];

const TRADE_REVIEWS: { value: LeagueSettings["tradeReview"]; label: string }[] = [
  { value: "league_vote", label: "League vote" },
  { value: "commissioner", label: "Commissioner" },
  { value: "none", label: "None" },
];

type Draft = Omit<LeagueSettings, "maxAddsPerWeek" | "maxAddsPerSeason" | "tradeDeadline"> & {
  // Blank = unlimited / no deadline.
  maxAddsPerWeek: string;
  maxAddsPerSeason: string;
  tradeDeadline: string;
};

const toDraft = (s: LeagueSettings): Draft => ({
  ...s,
  maxAddsPerWeek: s.maxAddsPerWeek === null ? "" : String(s.maxAddsPerWeek),
  maxAddsPerSeason: s.maxAddsPerSeason === null ? "" : String(s.maxAddsPerSeason),
  tradeDeadline: s.tradeDeadline ?? "",
});

const optionalInt = (v: string) => (v.trim() === "" ? null : Number(v));

const fromDraft = (d: Draft): LeagueSettings => ({
  ...d,
  maxAddsPerWeek: optionalInt(d.maxAddsPerWeek),
  maxAddsPerSeason: optionalInt(d.maxAddsPerSeason),
  tradeDeadline: d.tradeDeadline || null,
});

function toggle<T>(list: T[], item: T, order: readonly T[]): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : order.filter((x) => x === item || list.includes(x));
}

function Field({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <div className={styles.label}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help && <small>{help}</small>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function Chips<T extends string | number>({
  label, options, value, onChange, format = String,
}: { label: string; options: readonly T[]; value: T[]; onChange: (v: T[]) => void; format?: (v: T) => string }) {
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={styles.chip}
          aria-pressed={value.includes(o)}
          onClick={() => onChange(toggle(value, o, options))}
        >
          {format(o)}
        </button>
      ))}
    </div>
  );
}

export default function LeagueSettingsForm({ initial }: { initial: LeagueSettingsResponse }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toDraft(initial.settings));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus(null);
  };
  const num = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key, (e.target.value === "" ? "" : Number(e.target.value)) as never);

  const dirty = JSON.stringify(fromDraft(draft)) !== JSON.stringify(saved.settings);
  const zones = TIME_ZONES.includes(draft.timeZone) ? TIME_ZONES : [draft.timeZone, ...TIME_ZONES];
  const maxVotes = Math.max(1, saved.teamCount - 2);
  // Playoffs: one week per round, ending by the schedule's last week.
  const weeks = saved.weeks ?? [];
  const rounds = bracketRounds(Number(draft.playoffTeams) || 0);
  const lastStart = weeks.length - rounds + 1;
  const startWeeks = weeks.filter((w) => w.week >= 2 && (w.week <= lastStart || w.week === draft.playoffStartWeek));
  const endWeek = weeks.find((w) => w.week === draft.playoffStartWeek + rounds - 1);
  const locked = saved.playoffsStarted ?? false;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/league/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fromDraft(draft)),
      });
      const body = (await res.json().catch(() => ({}))) as LeagueSettingsResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status}).`);
      setSaved(body);
      setDraft(toDraft(body.settings));
      setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  const next = fmtWaiverTime(saved.nextRunAt, saved.settings.timeZone, "long");
  return (
    <form onSubmit={save} className={styles.form}>
      <p className={styles.sub}>
        {saved.leagueName} · Changes apply from now on. Past lineups and processed moves stay as they are; pending claims
        move to the next run on the new schedule.
      </p>

      <section className={styles.card} aria-labelledby="set-waivers">
        <h3 id="set-waivers">Waivers</h3>
        <Field label="Run days" help="Claims are processed and waivers clear only on these days.">
          <Chips
            label="Waiver run days"
            options={[1, 2, 3, 4, 5, 6, 7]}
            value={draft.waiverDaysOfWeek}
            onChange={(v) => set("waiverDaysOfWeek", v)}
            format={(d) => WEEKDAYS[d - 1]}
          />
        </Field>
        <Field label="Run time" htmlFor="set-time">
          <div className={styles.row}>
            <input
              id="set-time"
              type="time"
              required
              value={draft.waiverTime}
              onChange={(e) => set("waiverTime", e.target.value)}
            />
            <select aria-label="Time zone" value={draft.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </div>
        </Field>
        <Field label="Days on waivers" help="After a drop. Players clear at the first run after this. 0 = straight to free agents." htmlFor="set-wdays">
          <input id="set-wdays" type="number" min={0} max={14} required value={draft.waiverDays} onChange={num("waiverDays")} />
        </Field>
        <Field
          label="Waiver order"
          help={draft.waiverType === "faab"
            ? "Highest bid wins and pays; tied bids go by continual rolling priority, and only a tie win moves a team to the back."
            : undefined}
          htmlFor="set-wtype"
        >
          <select id="set-wtype" value={draft.waiverType} onChange={(e) => set("waiverType", e.target.value as Draft["waiverType"])}>
            {WAIVER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        {draft.waiverType === "faab" && (
          <>
            <Field
              label="FAAB budget"
              help={saved.settings.waiverType === "faab"
                ? "Per team, for the season. Changing it adds the difference to (or takes it from) every team’s remaining balance, never below $0, so money already spent stays spent."
                : "Per team, for the season. Saving the switch to FAAB sets every team’s balance to this; switching away later leaves balances as they are."}
              htmlFor="set-faab"
            >
              <div className={styles.row}>
                $<input id="set-faab" type="number" min={1} max={1000} required value={draft.faabBudget} onChange={num("faabBudget")} />
              </div>
            </Field>
            <Field
              label="Minimum bid"
              help="0 allows $0 bids. Applies to bids placed or changed from now on."
              htmlFor="set-faab-min"
            >
              <div className={styles.row}>
                $<input id="set-faab-min" type="number" min={0} max={draft.faabBudget || 0} required value={draft.faabMinBid} onChange={num("faabMinBid")} />
              </div>
            </Field>
          </>
        )}
        <Field label="Free agents after tip-off" help="A free agent goes on waivers once his game starts, until the next run.">
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.waiversAfterGameStart}
              onChange={(e) => set("waiversAfterGameStart", e.target.checked)}
            />
            On waivers once their game starts
          </label>
        </Field>
      </section>

      <section className={styles.card} aria-labelledby="set-il">
        <h3 id="set-il">Injured list</h3>
        {([
          ["IL", "ilSlots", "ilStatuses"],
          ["IL+", "ilPlusSlots", "ilPlusStatuses"],
        ] as const).map(([name, slots, statuses]) => (
          <div key={name} className={styles.group}>
            <Field label={`${name} slots`} htmlFor={`set-${slots}`}>
              <input id={`set-${slots}`} type="number" min={0} max={5} required value={draft[slots]} onChange={num(slots)} />
            </Field>
            <Field label={`Who can use ${name}`} help="A player can move in whenever his status today is one of these.">
              <Chips label={`${name} statuses`} options={INJURY_STATUSES} value={draft[statuses]} onChange={(v) => set(statuses, v)} />
            </Field>
          </div>
        ))}
      </section>

      <section className={styles.card} aria-labelledby="set-trades">
        <h3 id="set-trades">Trades</h3>
        <Field label="Review" htmlFor="set-review">
          <select id="set-review" value={draft.tradeReview} onChange={(e) => set("tradeReview", e.target.value as Draft["tradeReview"])}>
            {TRADE_REVIEWS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Review period (days)" help="After the other manager accepts." htmlFor="set-rdays">
          <input
            id="set-rdays"
            type="number"
            min={0}
            max={7}
            required
            disabled={draft.tradeReview === "none"}
            value={draft.tradeReviewDays}
            onChange={num("tradeReviewDays")}
          />
        </Field>
        <Field label="Veto votes to block" help={`League vote only. Up to ${maxVotes}.`} htmlFor="set-votes">
          <input
            id="set-votes"
            type="number"
            min={1}
            max={maxVotes}
            required
            disabled={draft.tradeReview !== "league_vote"}
            value={draft.tradeVetoVotes}
            onChange={num("tradeVetoVotes")}
          />
        </Field>
        <Field label="Trade deadline" help="Blank = no deadline." htmlFor="set-deadline">
          <div className={styles.row}>
            <input id="set-deadline" type="date" value={draft.tradeDeadline} onChange={(e) => set("tradeDeadline", e.target.value)} />
            {draft.tradeDeadline && (
              <button type="button" className={styles.btn} onClick={() => set("tradeDeadline", "")}>Clear</button>
            )}
          </div>
        </Field>
      </section>

      <section className={styles.card} aria-labelledby="set-playoffs">
        <h3 id="set-playoffs">Playoffs</h3>
        {locked && <p className={styles.note}>The playoffs have started, so these are fixed for the season.</p>}
        <Field label="Playoff teams" help={`Top seeds by the standings; byes when it isn’t a power of two. Up to ${Math.min(16, saved.teamCount)}.`} htmlFor="set-pteams">
          <input
            id="set-pteams"
            type="number"
            min={2}
            max={Math.min(16, saved.teamCount)}
            required
            disabled={locked}
            value={draft.playoffTeams}
            onChange={num("playoffTeams")}
          />
        </Field>
        <Field
          label="First playoff week"
          help={endWeek
            ? `${rounds} round${rounds === 1 ? "" : "s"}, one week each: weeks ${draft.playoffStartWeek}–${endWeek.week} (ends ${fmtGameDate(endWeek.endsOn)}).`
            : `${rounds} rounds, one week each, have to fit in the schedule.`}
          htmlFor="set-pstart"
        >
          <select
            id="set-pstart"
            disabled={locked}
            value={draft.playoffStartWeek}
            onChange={(e) => set("playoffStartWeek", Number(e.target.value))}
          >
            {startWeeks.map((w) => (
              <option key={w.week} value={w.week}>Week {w.week} · {fmtGameDate(w.startsOn)}</option>
            ))}
          </select>
        </Field>
        <Field label="Toilet bowl" help="The bottom teams play a bracket where the loser advances; the loser of its final finishes last. It ends with the playoff final.">
          <label className={styles.check}>
            <input type="checkbox" disabled={locked} checked={draft.toiletBowl} onChange={(e) => set("toiletBowl", e.target.checked)} />
            Bottom teams play the toilet bowl
          </label>
        </Field>
        <Field
          label="Toilet bowl teams"
          help={`Playoff and toilet bowl teams can add up to ${saved.teamCount} at most; anyone in neither is done after the regular season.`}
          htmlFor="set-tteams"
        >
          <input
            id="set-tteams"
            type="number"
            min={2}
            max={8}
            required
            disabled={locked || !draft.toiletBowl}
            value={draft.toiletBowlTeams}
            onChange={num("toiletBowlTeams")}
          />
        </Field>
      </section>

      <section className={styles.card} aria-labelledby="set-adds">
        <h3 id="set-adds">Adds</h3>
        <Field label="Adds per week" help="Free agents and waiver claims, per matchup week. Blank = unlimited." htmlFor="set-addw">
          <input id="set-addw" type="number" min={0} max={200} placeholder="Unlimited" value={draft.maxAddsPerWeek} onChange={(e) => set("maxAddsPerWeek", e.target.value)} />
        </Field>
        <Field label="Adds per season" help="Blank = unlimited." htmlFor="set-adds-season">
          <input id="set-adds-season" type="number" min={0} max={200} placeholder="Unlimited" value={draft.maxAddsPerSeason} onChange={(e) => set("maxAddsPerSeason", e.target.value)} />
        </Field>
      </section>

      <div className={styles.bar}>
        <p className={styles.next} aria-live="polite">
          {status && <b className={status.ok ? styles.ok : styles.error} role={status.ok ? "status" : "alert"}>{status.text} </b>}
          Waivers run {fmtWaiverDays(saved.settings.waiverDaysOfWeek)} at {next.split(" · ")[1]}. Next run{" "}
          <b>{next.split(" · ")[0]}</b>.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btn}
            disabled={!dirty || saving}
            onClick={() => { setDraft(toDraft(saved.settings)); setStatus(null); }}
          >
            Discard
          </button>
          <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </form>
  );
}
