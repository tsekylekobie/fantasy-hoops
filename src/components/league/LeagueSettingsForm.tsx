"use client";

// /league/settings: the league's rules, read-only (docs/design/league-settings.mockup.html,
// minus its save bar). A section nav on the left with each section's value, one card per
// section, every control disabled. The rules change on Yahoo; the Yahoo sync stores them.
import { useEffect, useState, type ReactNode } from "react";
import { fmtGameDate, fmtWaiverDays, fmtWaiverTime } from "@/components/players/format";
import { bracketRounds } from "@/lib/playoffs/bracket";
import {
  INJURY_STATUSES,
  STARTING_SLOTS,
  type GameLimits,
  type LeagueSettings,
  type LeagueSettingsResponse,
  type LineupSlot,
} from "@/lib/types";
import styles from "./LeagueSettings.module.css";

const WEEKDAYS: [string, string][] = [
  ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"],
  ["Fri", "Friday"], ["Sat", "Saturday"], ["Sun", "Sunday"],
];

const TIME_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "UTC",
];

type WaiverType = LeagueSettings["waiverType"];
type TradeReview = LeagueSettings["tradeReview"];

const WAIVER_TYPES: { value: WaiverType; label: string; short: string; help: string }[] = [
  { value: "continual_rolling", label: "Rolling", short: "Rolling", help: "Priority order; a team that wins a claim moves to the back." },
  { value: "reverse_standings", label: "Reverse standings", short: "Reverse", help: "The worst record claims first." },
  {
    value: "faab", label: "FAAB", short: "FAAB",
    help: "Blind bids from a season budget; the highest bid wins and pays, tied bids go by waiver priority.",
  },
];

const TRADE_REVIEWS: { value: TradeReview; label: string; help: string }[] = [
  { value: "none", label: "None", help: "Trades go through as soon as they’re accepted." },
  {
    value: "commissioner", label: "Commissioner", help: "The commissioner can veto a trade during the review period.",
  },
  {
    value: "league_vote", label: "League vote",
    help: "Other managers can vote to veto during the review period; the commissioner can veto too.",
  },
];

const SECTIONS = [
  { id: "waivers", label: "Waivers" },
  { id: "roster", label: "Roster & IL" },
  { id: "games", label: "Game limits" },
  { id: "adds", label: "Add limits" },
  { id: "trades", label: "Trades" },
  { id: "playoffs", label: "Playoffs" },
] as const;

type Draft = Omit<LeagueSettings, "maxAddsPerWeek" | "maxAddsPerSeason" | "tradeDeadline" | "gameLimits"> & {
  // Blank = unlimited / no deadline / only the total.
  maxAddsPerWeek: string;
  maxAddsPerSeason: string;
  tradeDeadline: string;
  // Game limits: the numbers are kept while switched off, so switching back restores them.
  gameLimitsOn: boolean;
  gameTotal: string;
  gameSlots: Partial<Record<LineupSlot, string>>;
};

/** Suggested total when a league first switches game limits on. */
const DEFAULT_GAME_TOTAL = 40;

const toDraft = ({ gameLimits, ...s }: LeagueSettings): Draft => ({
  ...s,
  maxAddsPerWeek: s.maxAddsPerWeek === null ? "" : String(s.maxAddsPerWeek),
  maxAddsPerSeason: s.maxAddsPerSeason === null ? "" : String(s.maxAddsPerSeason),
  tradeDeadline: s.tradeDeadline ?? "",
  gameLimitsOn: gameLimits !== null,
  gameTotal: String(gameLimits?.total ?? DEFAULT_GAME_TOTAL),
  gameSlots: Object.fromEntries(Object.entries(gameLimits?.slots ?? {}).map(([k, v]) => [k, String(v)])),
});

function toggle<T>(list: T[], item: T, order: readonly T[]): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : order.filter((x) => x === item || list.includes(x));
}

const label = <T extends { value: string; label: string }>(list: T[], v: string) => list.find((x) => x.value === v)?.label ?? v;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Daily", "Weekdays", "3×/wk" */
function daysShort(days: number[]): string {
  const s = fmtWaiverDays(days);
  return s === "daily" ? "Daily" : s === "on weekdays" ? "Weekdays" : `${days.length}×/wk`;
}

/** "3:00 AM" from "03:00" */
function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function Row({ label, help, htmlFor, children }: { label: string; help?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.lb}>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help && <small>{help}</small>}
      </div>
      <div className={styles.ctl}>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label, options, value, onChange, disabled,
}: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={styles.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.card} id={id} aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`}>{title}</h2>
      {lede && <p className={styles.lede}>{lede}</p>}
      {children}
    </section>
  );
}

export default function LeagueSettingsForm({ initial }: { initial: LeagueSettingsResponse }) {
  const saved = initial;
  // The controls are disabled; the draft only keeps them controlled.
  const [draft, setDraft] = useState(() => toDraft(initial.settings));
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // Highlights the section nearest the top of the screen.
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => e !== null);
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const num = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key, (e.target.value === "" ? "" : Number(e.target.value)) as never);

  const noDays = draft.waiverDaysOfWeek.length === 0;
  const zones = TIME_ZONES.includes(draft.timeZone) ? TIME_ZONES : [draft.timeZone, ...TIME_ZONES];
  const maxVotes = Math.max(1, saved.teamCount - 2);
  const isFaab = draft.waiverType === "faab";
  const review = TRADE_REVIEWS.find((r) => r.value === draft.tradeReview);
  const reviewHelp = review?.help;

  // Playoffs: one week per round, ending by the schedule's last week.
  const weeks = saved.weeks ?? [];
  const rounds = bracketRounds(Number(draft.playoffTeams) || 0);
  const lastStart = weeks.length - rounds + 1;
  const startWeeks = weeks.filter((w) => w.week >= 2 && (w.week <= lastStart || w.week === draft.playoffStartWeek));
  const endWeek = draft.playoffStartWeek + rounds - 1;
  const locked = saved.playoffsStarted ?? false;
  const regularWeeks = draft.playoffStartWeek - 1;
  const afterWeeks = Math.max(0, weeks.length - endWeek);
  const playoffTeams = Number(draft.playoffTeams) || 0;
  const toiletTeams = Number(draft.toiletBowlTeams) || 0;
  const startingSlots = saved.startingSlots ?? STARTING_SLOTS.map((slot) => ({ slot, count: 1 }));
  const slotSpots = startingSlots.filter((s) => s.count > 1).map((s) => `${s.slot} has ${s.count}`).join(", ");
  const capped = startingSlots.filter(({ slot }) => (draft.gameSlots[slot] ?? "").trim() !== "");
  const capSum = capped.reduce((n, { slot }) => n + Number(draft.gameSlots[slot]), 0);
  const uncapped = startingSlots.filter((s) => !capped.includes(s)).map((s) => s.slot);
  const idle = saved.teamCount - playoffTeams - (draft.toiletBowl ? toiletTeams : 0);

  const summaries: Record<(typeof SECTIONS)[number]["id"], string> = {
    waivers: `${WAIVER_TYPES.find((t) => t.value === draft.waiverType)?.short} · ${noDays ? "No days" : daysShort(draft.waiverDaysOfWeek)}`,
    roster: `${draft.ilSlots} IL · ${draft.ilPlusSlots} IL+`,
    games: draft.gameLimitsOn ? `${draft.gameTotal || "–"} / week` : "None",
    adds: draft.maxAddsPerWeek !== ""
      ? `${draft.maxAddsPerWeek} / week`
      : draft.maxAddsPerSeason !== "" ? `${draft.maxAddsPerSeason} / season` : "Unlimited",
    trades: label(TRADE_REVIEWS, draft.tradeReview),
    playoffs: `${draft.playoffTeams} teams`,
  };

  const nextRun = fmtWaiverTime(saved.nextRunAt, saved.settings.timeZone, "long").replace(" · ", ", ");

  return (
    <div className={styles.cols}>
      <nav className={styles.side} aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={active === s.id ? "location" : undefined}
            onClick={() => setActive(s.id)}
          >
            {s.label} <em>{summaries[s.id]}</em>
          </a>
        ))}
        <hr />
        <p className={styles.who}>
          Fixed once the season starts: {saved.teamCount} teams, 9 categories, {weeks.length}-week schedule.
        </p>
      </nav>

      <div className={styles.main}>
        <fieldset className={`${styles.fields} ${styles.sections} ${styles.view}`} disabled>
        <Section id="waivers" title="Waivers" lede={<>How dropped players and claims are handled. Next run: <b>{nextRun}</b>.</>}>
          <Row label="Waiver type" help="Who wins when two teams claim the same player.">
            <Segmented label="Waiver type" options={WAIVER_TYPES} value={draft.waiverType} onChange={(v) => set("waiverType", v)} />
            <p className={styles.hint}>{WAIVER_TYPES.find((t) => t.value === draft.waiverType)?.help}</p>
          </Row>
          {isFaab && (
            <Row label="FAAB budget" help="Per team, for the season.">
              <div className={styles.pair}>
                <label htmlFor="set-faab">
                  Season budget
                  <span className={styles.money}>
                    <span className={styles.unit}>$</span>
                    <input id="set-faab" className={styles.num} type="number" min={1} max={1000} required value={draft.faabBudget} onChange={num("faabBudget")} />
                  </span>
                </label>
                <label htmlFor="set-faab-min">
                  Minimum bid
                  <span className={styles.money}>
                    <span className={styles.unit}>$</span>
                    <input id="set-faab-min" className={styles.num} type="number" min={0} max={draft.faabBudget || 0} required value={draft.faabMinBid} onChange={num("faabMinBid")} />
                  </span>
                </label>
              </div>
            </Row>
          )}
          <Row label="Run days" help="Claims are processed and waivers clear only on these days.">
            <div className={styles.days} role="group" aria-label="Waiver run days">
              {WEEKDAYS.map(([short, full], i) => (
                <button
                  key={short}
                  type="button"
                  className={styles.day}
                  aria-pressed={draft.waiverDaysOfWeek.includes(i + 1)}
                  aria-label={full}
                  onClick={() => set("waiverDaysOfWeek", toggle(draft.waiverDaysOfWeek, i + 1, [1, 2, 3, 4, 5, 6, 7]))}
                >
                  {short}
                </button>
              ))}
            </div>
            {noDays && <p className={styles.warn}>Pick at least one day.</p>}
          </Row>
          <Row label="Run time">
            <label className={styles.unit} htmlFor="set-time">Time</label>
            <input id="set-time" className={styles.inp} type="time" required value={draft.waiverTime} onChange={(e) => set("waiverTime", e.target.value)} />
            <label className={styles.unit} htmlFor="set-tz">Time zone</label>
            <select id="set-tz" className={styles.inp} value={draft.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Row>
          <Row label="Days on waivers" help="After a drop. They clear at the first run after this; 0 = straight to free agents." htmlFor="set-wdays">
            <input id="set-wdays" className={styles.num} type="number" min={0} max={14} required value={draft.waiverDays} onChange={num("waiverDays")} />
            <span className={styles.unit}>days</span>
          </Row>
          <Row label="Free agents after tip-off" help="A free agent goes on waivers once his game starts, until the next run.">
            <label className={styles.switch}>
              <input type="checkbox" checked={draft.waiversAfterGameStart} onChange={(e) => set("waiversAfterGameStart", e.target.checked)} />
              Lock free agents once their game starts
            </label>
          </Row>
          <Row label="All adds by claim" help="Off: a free agent who isn't on waivers is added right away, even with FAAB. Dropping a player with no add is always immediate.">
            <label className={styles.switch}>
              <input type="checkbox" checked={draft.allAddsByClaim} onChange={(e) => set("allAddsByClaim", e.target.checked)} />
              Every add waits for the next waiver run
            </label>
          </Row>
        </Section>

        <Section
          id="roster"
          title="Roster & IL"
          lede={`Starting slots are fixed: ${startingSlots.flatMap(({ slot, count }) => Array<string>(count).fill(slot)).join(" ")}. IL players don’t count against the roster.`}
        >
          <Row label="Injured list slots" help="A player can move in whenever his status today is one of these.">
            <div className={styles.ilgrid}>
              {([
                ["IL", "ilSlots", "ilStatuses"],
                ["IL+", "ilPlusSlots", "ilPlusStatuses"],
              ] as const).map(([name, slots, statuses]) => (
                <div key={name} className={styles.ilrow} role="group" aria-label={`${name} slots`}>
                  <b>{name}</b>
                  <input
                    className={styles.num}
                    type="number"
                    min={0}
                    max={5}
                    required
                    aria-label={`${name} slots`}
                    value={draft[slots]}
                    onChange={num(slots)}
                  />
                  <span className={styles.unit}>slots for</span>
                  {INJURY_STATUSES.map((st) => (
                    <label key={st} className={styles.chk}>
                      <input
                        type="checkbox"
                        checked={draft[statuses].includes(st)}
                        onChange={() => set(statuses, toggle(draft[statuses], st, INJURY_STATUSES))}
                      />
                      {st}
                    </label>
                  ))}
                  {Number(draft[slots]) > 0 && draft[statuses].length === 0 && (
                    <p className={styles.warn}>Pick at least one status that can use {name}.</p>
                  )}
                </div>
              ))}
            </div>
            <p className={styles.hint}>
              Fewer slots than a team is using is refused until that team moves someone out.
            </p>
          </Row>
          <Row
            label="Claims and IL changes"
            help="Placing a claim needs a legal roster. If an IL player stops qualifying before the run, the claim still goes through; the roster stays illegal until it’s fixed."
          >
            <label className={styles.switch}>
              <input type="checkbox" checked={draft.claimsIgnoreIlStatus} onChange={(e) => set("claimsIgnoreIlStatus", e.target.checked)} />
              Let claims go through if an IL player’s status changes before the run
            </label>
          </Row>
        </Section>

        <Section id="games" title="Game limits" lede="Caps on how many games a team’s starters can play in one matchup week. Bench and IL games never count.">
          <Row label="Limit games" help="Changes start with the next matchup week; this week keeps its current limits.">
            <label className={styles.switch}>
              <input type="checkbox" checked={draft.gameLimitsOn} onChange={(e) => set("gameLimitsOn", e.target.checked)} />
              Cap games per matchup week
            </label>
          </Row>
          {draft.gameLimitsOn && (
            <>
              <Row label="Total games" help="All starting slots together." htmlFor="set-gtotal">
                <input
                  id="set-gtotal"
                  className={styles.num}
                  type="number"
                  min={1}
                  max={200}
                  required
                  value={draft.gameTotal}
                  onChange={(e) => set("gameTotal", e.target.value)}
                />
                <span className={styles.unit}>games per week</span>
              </Row>
              <Row
                label="Per position"
                help={`Per slot, summed across that slot’s spots${slotSpots ? ` (${slotSpots})` : ""}. Blank = only the total applies.`}
              >
                <div className={styles.glgrid}>
                  {startingSlots.map(({ slot }) => (
                    <label key={slot}>
                      {slot}
                      <input
                        className={styles.num}
                        type="number"
                        min={0}
                        max={200}
                        placeholder="—"
                        value={draft.gameSlots[slot] ?? ""}
                        onChange={(e) => set("gameSlots", { ...draft.gameSlots, [slot]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                {capped.length > 0 && (
                  <p className={styles.hint}>
                    Positions add up to {capSum}{uncapped.length > 0 ? ` plus unlimited ${uncapped.join(", ")}` : ""}, against a total of{" "}
                    {draft.gameTotal || "–"}.
                  </p>
                )}
              </Row>
              <Row label="Past the limit" help="Games are counted in tip-off order.">
                <p className={`${styles.hint} ${styles.text}`}>
                  Once a slot or the team is at its limit, later starts in it score nothing for the rest of the week. Managers see
                  their games used on Roster and are warned before starts that won’t count.
                </p>
              </Row>
            </>
          )}
        </Section>

        <Section id="adds" title="Add limits" lede="Free-agent adds and won waiver claims both count. Blank = unlimited.">
          <Row label="Adds per week" help="Per matchup week." htmlFor="set-addw">
            <input id="set-addw" className={`${styles.num} ${styles.wide}`} type="number" min={0} max={200} placeholder="Unlimited" value={draft.maxAddsPerWeek} onChange={(e) => set("maxAddsPerWeek", e.target.value)} />
          </Row>
          <Row label="Adds per season" htmlFor="set-adds">
            <input id="set-adds" className={`${styles.num} ${styles.wide}`} type="number" min={0} max={200} placeholder="Unlimited" value={draft.maxAddsPerSeason} onChange={(e) => set("maxAddsPerSeason", e.target.value)} />
          </Row>
        </Section>

        <Section id="trades" title="Trades" lede="What happens after the other manager accepts.">
          <Row label="Review" help={reviewHelp}>
            <Segmented label="Trade review" options={TRADE_REVIEWS} value={draft.tradeReview} onChange={(v) => set("tradeReview", v)} />
          </Row>
          {draft.tradeReview !== "none" && (
            <Row label="Review period" help="The trade goes through when it ends." htmlFor="set-rdays">
              <input id="set-rdays" className={styles.num} type="number" min={0} max={7} required value={draft.tradeReviewDays} onChange={num("tradeReviewDays")} />
              <span className={styles.unit}>days</span>
            </Row>
          )}
          {draft.tradeReview === "league_vote" && (
            <Row label="Veto votes to block" help={`The two teams in the trade can’t vote, so up to ${maxVotes}.`} htmlFor="set-votes">
              <input id="set-votes" className={styles.num} type="number" min={1} max={maxVotes} required value={draft.tradeVetoVotes} onChange={num("tradeVetoVotes")} />
              <span className={styles.unit}>of {maxVotes} eligible managers</span>
            </Row>
          )}
          <Row label="Trade deadline" help="Blank = no deadline." htmlFor="set-deadline">
            <input id="set-deadline" className={styles.inp} type="date" value={draft.tradeDeadline} onChange={(e) => set("tradeDeadline", e.target.value)} />
          </Row>
        </Section>

        <Section id="playoffs" title="Playoffs" lede="One week per round. Ties go to the better seed.">
          <fieldset className={styles.fields} disabled={locked}>
            <Row label="Playoff teams" help="Top seeds by the standings; byes when it isn’t a power of two." htmlFor="set-pteams">
              <input
                id="set-pteams"
                className={styles.num}
                type="number"
                min={2}
                max={Math.min(16, saved.teamCount)}
                required
                value={draft.playoffTeams}
                onChange={num("playoffTeams")}
              />
              <span className={styles.unit}>teams · {plural(rounds, "round")}</span>
            </Row>
            <Row
              label="Playoffs start"
              help={lastStart >= 2 ? `Weeks 2–${lastStart} allowed for ${plural(rounds, "round")}.` : `${plural(rounds, "round")} don’t fit in the schedule.`}
              htmlFor="set-pstart"
            >
              <select
                id="set-pstart"
                className={styles.inp}
                value={draft.playoffStartWeek}
                onChange={(e) => set("playoffStartWeek", Number(e.target.value))}
              >
                {startWeeks.map((w) => (
                  <option key={w.week} value={w.week}>
                    Week {w.week} ({fmtGameDate(w.startsOn)}) – ends week {w.week + rounds - 1}
                  </option>
                ))}
              </select>
              {weeks.length > 0 && (
                <div className={styles.bracket} aria-hidden="true">
                  {regularWeeks > 0 && (
                    <span className={styles.reg} style={{ flexGrow: regularWeeks }}>
                      {regularWeeks === 1 ? "Week 1" : `Weeks 1–${regularWeeks}`} regular season
                    </span>
                  )}
                  <span className={styles.po} style={{ flexGrow: Math.max(rounds, 1) }}>
                    {rounds === 1 ? `${draft.playoffStartWeek}` : `${draft.playoffStartWeek}–${endWeek}`} playoffs
                  </span>
                  {afterWeeks > 0 && <span className={styles.reg} style={{ flexGrow: afterWeeks }}>{afterWeeks} after</span>}
                </div>
              )}
            </Row>
            <Row label="Toilet bowl" help="The bottom teams play a bracket where the loser advances; its last loser finishes last.">
              <label className={styles.switch}>
                <input type="checkbox" checked={draft.toiletBowl} onChange={(e) => set("toiletBowl", e.target.checked)} />
                Play a toilet bowl
              </label>
              {draft.toiletBowl && (
                <>
                  <span className={styles.unit}>with the bottom</span>
                  <input
                    className={styles.num}
                    type="number"
                    min={2}
                    max={8}
                    required
                    aria-label="Toilet bowl teams"
                    value={draft.toiletBowlTeams}
                    onChange={num("toiletBowlTeams")}
                  />
                  <span className={styles.unit}>teams</span>
                  <p className={styles.hint}>
                    {playoffTeams} in the playoffs + {toiletTeams} in the toilet bowl
                    {idle > 0
                      ? `; ${idle === 1 ? `seed ${playoffTeams + 1} is` : `seeds ${playoffTeams + 1}–${playoffTeams + idle} are`} done after week ${regularWeeks}.`
                      : idle < 0 ? `: more than the league’s ${saved.teamCount} teams.` : "."}
                  </p>
                </>
              )}
            </Row>
          </fieldset>
        </Section>
        </fieldset>

      </div>
    </div>
  );
}
