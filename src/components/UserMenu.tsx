"use client";

// Header sign-in control: a "Sign in" button when signed out, and the user's
// avatar with a small menu (email, Edit team, sign out) when signed in.
import { useEffect, useRef, useState } from "react";
import type { SessionResponse, SessionUser } from "@/lib/types";
import { useSession } from "./SessionProvider";
import styles from "./UserMenu.module.css";

export default function UserMenu() {
  // Known from the server on first render (SessionProvider). The fetch slides the
  // session's expiry forward (and clears an expired cookie); its answer wins.
  const initial = useSession();
  const [session, setSession] = useState<SessionResponse>(initial);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? (r.json() as Promise<SessionResponse>) : null))
      .then((s) => !cancelled && s && setSession(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!session.user) return <SignInButton />;
  return <SignedIn user={session.user} />;
}

type Provider = SessionResponse["providers"][number];
const PROVIDER_LABEL: Record<Provider, string> = { google: "Google", yahoo: "Yahoo" };

/** Goes to a provider's sign-in, returning to the page as it is now (query string included). */
function startSignIn(e: React.MouseEvent<HTMLAnchorElement>, provider: Provider) {
  e.preventDefault();
  const next = window.location.pathname + window.location.search;
  window.location.href = `/api/auth/${provider}/start?next=${encodeURIComponent(next)}`;
}

function ProviderLink({ provider, className, children }: { provider: Provider; className: string; children: React.ReactNode }) {
  return (
    <a href={`/api/auth/${provider}/start`} className={className} onClick={(e) => startSignIn(e, provider)}>
      {children}
    </a>
  );
}

/**
 * Sign-in with each configured provider (or the mock sign-in in development).
 * With one provider it's a single "Sign in with …" button. With several,
 * `layout="menu"` (the header) is a "Sign in" button that opens a menu of them,
 * and `layout="stack"` shows a button for each.
 */
export function SignInButton({ layout = "menu" }: { layout?: "menu" | "stack" }) {
  const { mock, providers } = useSession();
  if (mock || providers.length === 0) {
    return (
      <ProviderLink provider="google" className={styles.signIn}>
        Sign in (mock)
      </ProviderLink>
    );
  }
  if (providers.length === 1 || layout === "stack") {
    return (
      <div className={styles.stack}>
        {providers.map((p) => (
          <ProviderLink key={p} provider={p} className={styles.signIn}>
            <ProviderIcon provider={p} />
            Sign in with {PROVIDER_LABEL[p]}
          </ProviderLink>
        ))}
      </div>
    );
  }
  return <SignInMenu providers={providers} />;
}

function SignInMenu({ providers }: { providers: Provider[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, root);
  return (
    <div className={styles.root} ref={root}>
      <button type="button" className={styles.signIn} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Sign in
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {providers.map((p) => (
            <ProviderLink key={p} provider={p} className={`${styles.item} ${styles.providerItem}`}>
              <ProviderIcon provider={p} />
              Continue with {PROVIDER_LABEL[p]}
            </ProviderLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** Closes a popup menu on a click outside `root` or Escape. */
function useDismiss(open: boolean, setOpen: (open: boolean) => void, root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, root]);
}

function SignedIn({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useDismiss(open, setOpen, root);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }

  return (
    <div className={styles.root} ref={root}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <UserAvatar user={user} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.who}>
            <span className={styles.name}>{user.name}</span>
            <span className={styles.email}>{user.email}</span>
          </div>
          <a role="menuitem" className={styles.item} href="/my-team?edit=team">
            Edit team
          </a>
          <button type="button" role="menuitem" className={styles.item} onClick={signOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.charAt(0) ?? "") + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
}

/** Profile photo from the sign-in provider, falling back to initials. */
function UserAvatar({ user }: { user: SessionUser }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.avatar} aria-hidden="true">
      {user.pictureUrl && !failed ? (
        <img src={user.pictureUrl} alt="" width={36} height={36} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        userInitials(user.name)
      )}
    </span>
  );
}

function ProviderIcon({ provider }: { provider: Provider }) {
  return provider === "yahoo" ? <YahooIcon /> : <GoogleIcon />;
}

function YahooIcon() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <rect width="18" height="18" rx="4" fill="#6001D2" />
      <text x="9" y="13" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif">
        Y!
      </text>
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
