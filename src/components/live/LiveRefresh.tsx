"use client";

// Re-renders a server-rendered page with fresh data while games are live
// (router.refresh keeps client state, so Flash cells can see what changed).
// With `countdown`, it also shows when the next update comes (LiveCountdown);
// otherwise it renders nothing.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import LiveCountdown from "./LiveCountdown";
import { useLivePoll } from "./useLivePoll";

export default function LiveRefresh({ active, countdown = false }: { active: boolean; countdown?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const nextAt = useLivePoll(active, () => startTransition(() => router.refresh()));
  return countdown && active ? <LiveCountdown nextAt={nextAt} pending={pending} /> : null;
}
