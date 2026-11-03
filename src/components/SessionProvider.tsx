"use client";

// The signed-in user, read on the server by the root layout, so the header and
// pages know who's viewing on first render (no flash of the wrong tabs).
import { createContext, useContext } from "react";
import type { SessionResponse } from "@/lib/types";

const Session = createContext<SessionResponse>({ user: null, mock: false });

export default function SessionProvider({ value, children }: { value: SessionResponse; children: React.ReactNode }) {
  return <Session.Provider value={value}>{children}</Session.Provider>;
}

export function useSession(): SessionResponse {
  return useContext(Session);
}

/** True when signed in: league info (owners, waivers, add/claim) is shown only then. */
export function useSignedIn(): boolean {
  return useContext(Session).user !== null;
}
