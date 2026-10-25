"use client";

// Top navigation shared by every page: logo, section tabs, theme and account.
// Tabs follow docs/design/matchup.mockup.html (League is added when it ships).
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import styles from "./SiteHeader.module.css";

const TABS = [
  { href: "/", label: "Players" },
  { href: "/my-team", label: "My team" },
  { href: "/matchup", label: "Matchup" },
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
          const on = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className={on ? styles.on : undefined} aria-current={on ? "page" : undefined}>
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
