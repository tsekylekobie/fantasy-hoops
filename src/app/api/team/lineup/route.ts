// GET /api/team/lineup?date=yyyy-mm-dd  (default: today, Pacific)
// The signed-in user's team, read-only (the lineup as stored; Yahoo sets it).
// Contract: TeamLineupResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { gameDayToday } from "@/lib/gameDay";
import { pool } from "@/lib/db";
import { getTeamLineup, loadValues } from "@/lib/queries/lineup";
import { NO_STORE, errorResponse, handleError, parseDate, requireTeam } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const team = await requireTeam();
    if (team instanceof NextResponse) return team;
    const raw = new URL(req.url).searchParams.get("date");
    const date = raw === null ? gameDayToday() : parseDate(raw);
    if (!date) return errorResponse("date must be yyyy-mm-dd", 400);
    const values = await loadValues(pool, team.season);
    return NextResponse.json(await getTeamLineup(pool, team, date, values), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/team/lineup", err);
  }
}
