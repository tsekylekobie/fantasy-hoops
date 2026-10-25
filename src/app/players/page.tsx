import type { Metadata } from "next";
import { Suspense } from "react";
import PlayersBrowser from "@/components/players/PlayersBrowser";

export const metadata: Metadata = { title: "Players · Fantasy Hoops" };

// The players table and modal are client-side and keep their state
// (scope, search, position, mode, page, open player) in the URL query string.
export default function PlayersPage() {
  return (
    <Suspense fallback={null}>
      <PlayersBrowser />
    </Suspense>
  );
}
