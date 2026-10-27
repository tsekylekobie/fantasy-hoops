"use client";

// Re-renders a server-rendered page with fresh data while games are live
// (router.refresh keeps client state, so Flash cells can see what changed).
import { useRouter } from "next/navigation";
import { useLivePoll } from "./useLivePoll";

export default function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useLivePoll(active, () => router.refresh());
  return null;
}
