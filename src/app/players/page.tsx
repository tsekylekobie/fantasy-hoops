import { Suspense } from "react";
import PlayersBrowser from "@/components/players/PlayersBrowser";

// The players table and modal are client-side and keep their state
// (search, position, mode, page, open player) in the URL query string.
export default function Home() {
  return (
    <Suspense fallback={null}>
      <PlayersBrowser />
    </Suspense>
  );
}
