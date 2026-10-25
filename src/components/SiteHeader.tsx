"use client";

// Top navigation shared by every page: logo, section tabs, theme and account.
// Tabs follow docs/design/matchup.mockup.html. Other teams' pages (/team/N) sit under League.
// On phones the tabs become a bottom tab bar with icons (docs/design/my-team-phone.mockup.html).
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import styles from "./SiteHeader.module.css";

// Icon paths from the phone mockup's tab bar (24×24, stroked).
const TABS = [
  {
    href: "/league",
    label: "League",
    also: "/team/",
    icon: (
      <>
        <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />
        <path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 13v4M8 21h8M9 17h6" />
      </>
    ),
  },
  { href: "/my-team", label: "My team", icon: <path d="M8 3l-5 3 2 4 2-1v12h10V9l2 1 2-4-5-3c-.5 1.7-2 3-4 3S8.5 4.7 8 3z" /> },
  {
    href: "/matchup",
    label: "Matchup",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8" />
      </>
    ),
  },
  {
    href: "/players",
    label: "Players",
    icon: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </>
    ),
  },
];

export default function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className={styles.nav}>
      <Link href="/" className={styles.logo}>
        Fantasy <b>Hoops</b>
      </Link>
      <nav className={styles.tabs} aria-label="Main">
        {TABS.map((t) => {
          const on = pathname.startsWith(t.href) || (t.also !== undefined && pathname.startsWith(t.also));
          return (
            <Link key={t.href} href={t.href} className={on ? styles.on : undefined} aria-current={on ? "page" : undefined}>
              <svg
                className={styles.icon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {t.icon}
              </svg>
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className={styles.actions}>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
