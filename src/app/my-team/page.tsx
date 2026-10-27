import type { Metadata } from "next";
import { Suspense } from "react";
import MyTeam from "@/components/my-team/MyTeam";

export const metadata: Metadata = { title: "Roster · Fantasy Hoops" };

// Client-side: the lineup loads from /api/team/lineup and saves on each move.
export default function MyTeamPage() {
  return (
    <Suspense fallback={null}>
      <MyTeam />
    </Suspense>
  );
}
