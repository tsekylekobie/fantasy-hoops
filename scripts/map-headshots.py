#!/usr/bin/env python3
"""Map BALLDONTLIE players to NBA person ids (for NBA CDN headshots).

BALLDONTLIE has no NBA person id, so we match on normalized full name, break
ties with team abbreviation, prefer currently active NBA players, then apply
data/headshot-overrides.json last. Writes players.nba_person_id (changed rows
only) and prints the unmatched players a human should look at.

Usage (from the repo root):
    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
    .venv/bin/python scripts/map-headshots.py            # write to the DB
    .venv/bin/python scripts/map-headshots.py --dry-run  # report only
    .venv/bin/python scripts/map-headshots.py --players-json data/samples/players.json

Re-run each season (new rookies, trades).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERRIDES_PATH = ROOT / "data" / "headshot-overrides.json"
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
RECENT_SEASONS = (2025, 2026)


def normalize(name: str) -> str:
    """'Nikola Jokić' -> 'nikolajokic'; "De'Aaron Fox" -> 'deaaronfox';
    'Jaren Jackson Jr.' -> 'jarenjackson'. Spaces are dropped too so
    'Karl-Anthony' / 'Karl Anthony' and 'da Silva' / 'daSilva' agree."""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)  # drop . ' etc.
    tokens = [t for t in re.split(r"[\s-]+", s) if t]
    while len(tokens) > 1 and tokens[-1] in SUFFIXES:
        tokens.pop()
    return "".join(tokens)


@dataclass
class NbaPlayer:
    person_id: int
    name: str
    team_abbr: str  # "" when not on a team
    active: bool
    to_year: int


@dataclass
class BdlPlayer:
    id: int
    first_name: str
    last_name: str
    team_abbr: str | None
    current_id: int | None

    @property
    def name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


# ---------------------------------------------------------------- NBA side


def fetch_nba_players(retries: int = 3, timeout: int = 30) -> tuple[list[NbaPlayer], str]:
    """All NBA players (historical + current) with person id and team."""
    from nba_api.stats.endpoints import commonallplayers

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = commonallplayers.CommonAllPlayers(
                is_only_current_season=0, timeout=timeout
            )
            rows = resp.get_normalized_dict()["CommonAllPlayers"]
            out = []
            for r in rows:
                try:
                    to_year = int(r.get("TO_YEAR") or 0)
                except ValueError:
                    to_year = 0
                out.append(
                    NbaPlayer(
                        person_id=int(r["PERSON_ID"]),
                        name=r["DISPLAY_FIRST_LAST"] or "",
                        team_abbr=(r.get("TEAM_ABBREVIATION") or "").upper(),
                        active=int(r.get("ROSTERSTATUS") or 0) == 1,
                        to_year=to_year,
                    )
                )
            if out:
                return out, "stats.nba.com CommonAllPlayers"
        except Exception as e:  # network errors, timeouts, blocked
            last_err = e
            print(f"  CommonAllPlayers attempt {attempt}/{retries} failed: {type(e).__name__}", file=sys.stderr)
            time.sleep(2 * attempt)

    # Offline fallback bundled with nba_api: ids and active flag, no team.
    from nba_api.stats.static import players as static_players

    print(f"  falling back to nba_api static players (no team data); last error: {last_err!r}", file=sys.stderr)
    out = [
        NbaPlayer(p["id"], p["full_name"], "", bool(p["is_active"]), 9999 if p["is_active"] else 0)
        for p in static_players.get_players()
    ]
    return out, "nba_api static players (fallback)"


# ---------------------------------------------------------------- matching


def pick(bdl: BdlPlayer, candidates: list[NbaPlayer]) -> tuple[NbaPlayer | None, str]:
    """Return (match, reason). reason is 'name', 'team', 'active', 'recent',
    'none' or 'ambiguous'."""
    if not candidates:
        return None, "none"
    if len(candidates) == 1:
        return candidates[0], "name"
    pool = candidates
    if bdl.team_abbr:
        same_team = [c for c in pool if c.team_abbr == bdl.team_abbr]
        if len(same_team) == 1:
            return same_team[0], "team"
        if same_team:
            pool = same_team
    active = [c for c in pool if c.active]
    if len(active) == 1:
        return active[0], "active"
    if active:
        pool = active
    latest = max(c.to_year for c in pool)
    newest = [c for c in pool if c.to_year == latest]
    if len(newest) == 1:
        return newest[0], "recent"
    return None, "ambiguous"


def load_overrides() -> dict[int, int | None]:
    if not OVERRIDES_PATH.exists():
        return {}
    raw = json.loads(OVERRIDES_PATH.read_text())
    out: dict[int, int | None] = {}
    for k, v in raw.items():
        if k.startswith("_"):  # "_comment" keys
            continue
        out[int(k)] = None if v is None else int(v)
    return out


# ---------------------------------------------------------------- BDL side


def load_bdl_from_json(path: Path) -> list[BdlPlayer]:
    data = json.loads(path.read_text())
    rows = data["data"] if isinstance(data, dict) else data
    return [
        BdlPlayer(
            id=r["id"],
            first_name=r["first_name"],
            last_name=r["last_name"],
            team_abbr=(r.get("team") or {}).get("abbreviation"),
            current_id=None,
        )
        for r in rows
    ]


def load_bdl_from_db(conn) -> list[BdlPlayer]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, t.abbreviation, p.nba_person_id
            FROM players p LEFT JOIN teams t ON t.id = p.team_id
            ORDER BY p.id
            """
        )
        return [BdlPlayer(r[0], r[1], r[2], r[3], r[4]) for r in cur.fetchall()]


def recent_player_ids(conn) -> tuple[dict[int, int], str]:
    """Players worth a human look: {bdl_id: games played} from recent seasons
    when we have stats, else players on a current team (gp = 0)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT player_id, count(*) FROM player_game_stats
            WHERE season = ANY(%s) AND min > 0
            GROUP BY player_id
            """,
            (list(RECENT_SEASONS),),
        )
        rows = cur.fetchall()
        if rows:
            return {r[0]: r[1] for r in rows}, f"played in seasons {RECENT_SEASONS}"
        # Current NBA teams are BALLDONTLIE ids 1-30 (the rest are defunct).
        cur.execute("SELECT id FROM players WHERE team_id BETWEEN 1 AND 30")
        return {r[0]: 0 for r in cur.fetchall()}, "on a current team (no recent stats yet)"


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="report only; don't write to the DB")
    ap.add_argument("--database-url", help="Postgres URL (default: DATABASE_URL from env/.env)")
    ap.add_argument(
        "--players-json",
        type=Path,
        help="read BALLDONTLIE players from a /players response file instead of the DB (implies --dry-run)",
    )
    args = ap.parse_args()

    conn = None
    if args.players_json:
        bdl = load_bdl_from_json(args.players_json)
        source = str(args.players_json)
    else:
        from dotenv import load_dotenv
        import psycopg

        load_dotenv(ROOT / ".env")
        url = args.database_url or os.environ.get("DATABASE_URL")
        if not url:
            print("DATABASE_URL is not set (use --database-url or .env)", file=sys.stderr)
            return 2
        conn = psycopg.connect(url)
        bdl = load_bdl_from_db(conn)
        source = "players table"
    print(f"BALLDONTLIE players: {len(bdl)} from {source}")
    if not bdl:
        print("Nothing to map.")
        return 0

    nba, nba_source = fetch_nba_players()
    print(f"NBA players: {len(nba)} from {nba_source} ({sum(p.active for p in nba)} active)")

    index: dict[str, list[NbaPlayer]] = {}
    for p in nba:
        index.setdefault(normalize(p.name), []).append(p)

    overrides = load_overrides()
    result: dict[int, int | None] = {}
    reasons: dict[int, str] = {}
    for b in bdl:
        match, reason = pick(b, index.get(normalize(b.name), []))
        result[b.id] = match.person_id if match else None
        reasons[b.id] = reason
    applied = 0
    for bid, pid in overrides.items():
        if bid in result:
            result[bid] = pid
            reasons[bid] = "override"
            applied += 1

    # Two BALLDONTLIE rows pointing at one NBA person is suspicious.
    seen: dict[int, list[int]] = {}
    for bid, pid in result.items():
        if pid is not None:
            seen.setdefault(pid, []).append(bid)
    dupes = {pid: bids for pid, bids in seen.items() if len(bids) > 1}

    counts: dict[str, int] = {}
    for r in reasons.values():
        counts[r] = counts.get(r, 0) + 1
    matched = sum(1 for v in result.values() if v is not None)
    print(f"\nMatched {matched}/{len(bdl)} ({100 * matched / len(bdl):.1f}%)")
    print("  by: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print(f"  overrides applied: {applied} (of {len(overrides)} in {OVERRIDES_PATH.relative_to(ROOT)})")
    if dupes:
        print(f"  WARNING: {len(dupes)} NBA ids assigned to more than one BALLDONTLIE player:")
        by_id = {b.id: b for b in bdl}
        for pid, bids in sorted(dupes.items()):
            print(f"    {pid}: " + ", ".join(f"{b} {by_id[b].name}" for b in bids))

    by_id = {b.id: b for b in bdl}
    if conn is not None:
        recent, label = recent_player_ids(conn)
        pool = [b for b in bdl if b.id in recent]
        rmatched = sum(1 for b in pool if result[b.id] is not None)
        if pool:
            print(f"\nPlayers {label}: matched {rmatched}/{len(pool)} ({100 * rmatched / len(pool):.1f}%)")
        unmatched = sorted(
            (b for b in pool if result[b.id] is None), key=lambda b: (-recent[b.id], b.last_name)
        )
    else:
        unmatched = [b for b in bdl if result[b.id] is None]
        recent = {}
    if unmatched:
        print(f"\nUnmatched ({len(unmatched)}); add to {OVERRIDES_PATH.relative_to(ROOT)} as \"<bdl_id>\": <nba_person_id>:")
        for b in unmatched:
            gp = f" gp={recent[b.id]}" if recent.get(b.id) else ""
            print(f"  {b.id:>8}  {b.name:<30} {b.team_abbr or '-':<4} {reasons[b.id]}{gp}")

    changes = [(pid, bid) for bid, pid in result.items() if by_id[bid].current_id != pid]
    print(f"\nRows to update: {len(changes)}")
    if conn is None or args.dry_run:
        print("Dry run: no changes written.")
    else:
        with conn.cursor() as cur:
            cur.executemany(
                "UPDATE players SET nba_person_id = %s, updated_at = now() WHERE id = %s",
                changes,
            )
        conn.commit()
        print(f"Updated {len(changes)} rows.")
    if conn is not None:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
