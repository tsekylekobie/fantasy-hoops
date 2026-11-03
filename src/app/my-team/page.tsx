import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSignedInPage } from "@/lib/auth/viewer";
import MyTeam from "@/components/my-team/MyTeam";

export const metadata: Metadata = { title: "Roster · Fantasy Hoops" };
export const dynamic = "force-dynamic";

// Client-side: the lineup loads from /api/team/lineup and saves on each move. Signed in only.
export default async function MyTeamPage() {
  await requireSignedInPage();
  return (
    <Suspense fallback={null}>
      <MyTeam />
    </Suspense>
  );
}
