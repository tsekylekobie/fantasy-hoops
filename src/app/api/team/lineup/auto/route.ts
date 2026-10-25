// POST /api/team/lineup/auto  { date, scope: "day" | "week" }
// Sets the best lineup for the day, or for every day left in its week.
// Contract: AutoLineupRequest / AutoLineupResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { autoSetLineup, getTeamLineup, loadValues, remainingWeekDays } from "@/lib/queries/lineup";
import type { AutoLineupResponse } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, parseDate, requireTeam } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const body = (await req.json().catch(() => null)) as { date?: unknown; scope?: unknown } | null;
    const date = parseDate(body?.date);
    if (!date) return errorResponse("date must be yyyy-mm-dd", 400);
    if (body?.scope !== "day" && body?.scope !== "week") return errorResponse('scope must be "day" or "week"', 400);
    const dates = body.scope === "day" ? [date] : await remainingWeekDays(pool, team, date);
    if (dates.length === 0) return errorResponse("Past days are locked.", 409);
    const values = await loadValues(pool, team.season);
    const changed = await autoSetLineup(pool, team, dates, values);
    const res: AutoLineupResponse = { ...(await getTeamLineup(pool, team, date, values)), changed };
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/team/lineup/auto", err);
  }
}
