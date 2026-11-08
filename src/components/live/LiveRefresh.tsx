"use client";

// Re-renders a server-rendered page with fresh data while games are live
// (router.refresh keeps client state, so Flash cells can see what changed).
// With `countdown`, it also shows when the next update comes (LiveCountdown),
// and with `pin` that countdown follows the page down (pinned to the top once
// scrolled off); otherwise it renders nothing. A page that shows the countdown
// in more than one place calls useLiveRefresh itself.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import LiveCountdown from "./LiveCountdown";
import { useLivePoll } from "./useLivePoll";

/** Polls with router.refresh while `active`: when the next one is due, and whether one is loading. */
export function useLiveRefresh(active: boolean): { nextAt: number | null; pending: boolean } {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const nextAt = useLivePoll(active, () => startTransition(() => router.refresh()));
  return { nextAt, pending };
}

export default function LiveRefresh({ active, countdown = false, pin = false }: { active: boolean; countdown?: boolean; pin?: boolean }) {
  const { nextAt, pending } = useLiveRefresh(active);
  return countdown && active ? <LiveCountdown nextAt={nextAt} pending={pending} pin={pin} /> : null;
}
