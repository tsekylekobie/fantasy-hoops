"use client";

// The League page's Standings card: Standings | Playoffs. Both views are
// rendered on the server and passed in; this only switches between them.
import { useState, type ReactNode } from "react";
import SegmentedToggle from "@/components/SegmentedToggle";
import styles from "./LeagueView.module.css";

type View = "standings" | "playoffs";

const OPTIONS = [
  { value: "standings", label: "Standings" },
  { value: "playoffs", label: "Playoffs" },
] as const;

export default function StandingsCard({
  standings, playoffs, initial = "standings",
}: { standings: ReactNode; playoffs: ReactNode; initial?: View }) {
  const [view, setView] = useState<View>(initial);
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h3>{view === "standings" ? "Standings" : "Playoffs"}</h3>
        <SegmentedToggle label="Standings or playoffs" options={OPTIONS} value={view} onChange={setView} />
      </div>
      {view === "standings" ? standings : playoffs}
    </section>
  );
}
