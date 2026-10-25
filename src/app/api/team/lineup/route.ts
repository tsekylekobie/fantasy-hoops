// GET /api/team/lineup?date=yyyy-mm-dd  (default: the league's today)
// PUT /api/team/lineup  { date, slots: [{ playerId, slot }] }
// The signed-in user's team. Contract: TeamLineupResponse and
// LineupUpdateRequest in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getTeamLineup, loadValues, setLineup } from "@/lib/queries/lineup";
import { LINEUP_SLOTS, type LineupSlot } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, parseDate, requireTeam } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const raw = new URL(req.url).searchParams.get("date");
    const date = raw === null ? team.today : parseDate(raw);
    if (!date) return errorResponse("date must be yyyy-mm-dd", 400);
    const values = await loadValues(pool, team.season);
    return NextResponse.json(await getTeamLineup(pool, team, date, values), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/team/lineup", err);
  }
}

export async function PUT(req: Request) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const body = (await req.json().catch(() => null)) as { date?: unknown; slots?: unknown } | null;
    const date = parseDate(body?.date);
    if (!date) return errorResponse("date must be yyyy-mm-dd", 400);
    if (!Array.isArray(body?.slots)) return errorResponse("slots must be an array", 400);
    const next = new Map<number, LineupSlot>();
    for (const s of body.slots as { playerId?: unknown; slot?: unknown }[]) {
      if (!Number.isInteger(s?.playerId) || !LINEUP_SLOTS.includes(s?.slot as LineupSlot)) {
        return errorResponse("each slot needs a playerId and a valid slot", 400);
      }
      next.set(s.playerId as number, s.slot as LineupSlot);
    }
    const values = await loadValues(pool, team.season);
    await setLineup(pool, team, date, next, values);
    return NextResponse.json(await getTeamLineup(pool, team, date, values), { headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/team/lineup", err);
  }
}
