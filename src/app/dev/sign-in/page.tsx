// Mock sign-in for local dev: pick an existing test user or make a new one,
// instead of going through Google. 404s when mock auth is off (always in production).
import { notFound } from "next/navigation";
import { mockAuthEnabled, safeNext } from "@/lib/auth/config";
import { pool } from "@/lib/db";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

// Offered until any mock user exists (e.g. before `npm run db:seed:league`).
const PRESETS = [
  { email: "commish@example.com", name: "Commissioner" },
  { email: "manager2@example.com", name: "Manager Two" },
];

export default async function MockSignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!mockAuthEnabled()) notFound();
  const next = safeNext((await searchParams).next);

  const { rows } = await pool.query<{ email: string; name: string }>(
    `SELECT email, name FROM users WHERE google_sub LIKE 'mock:%' ORDER BY last_seen_at DESC`,
  );
  const users = rows.length > 0 ? rows : PRESETS;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.badge}>Local dev · mock sign-in</p>
        <h1 className={styles.title}>Sign in as…</h1>
        <p className={styles.sub}>Stands in for Google while developing. Unavailable in production.</p>

        <ul className={styles.users}>
          {users.map((u) => (
            <li key={u.email}>
              <form method="post" action="/api/auth/mock">
                <input type="hidden" name="email" value={u.email} />
                <input type="hidden" name="name" value={u.name} />
                <input type="hidden" name="next" value={next} />
                <button type="submit" className={styles.user}>
                  <span className={styles.userName}>{u.name}</span>
                  <span className={styles.userEmail}>{u.email}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>

        <form method="post" action="/api/auth/mock" className={styles.custom}>
          <input type="hidden" name="next" value={next} />
          <input name="name" placeholder="Name" aria-label="Name" className={styles.input} />
          <input name="email" type="email" required placeholder="email@example.com" aria-label="Email" className={styles.input} />
          <button type="submit" className={styles.primary}>Sign in</button>
        </form>
      </div>
    </main>
  );
}
