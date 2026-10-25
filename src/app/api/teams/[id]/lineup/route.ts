// GET /api/teams/:id/lineup?date=yyyy-mm-dd  (default: the league's today)
// Any team's lineup, read-only. Contract: TeamLineupResponse in src/lib/types.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getTeamLineup, loadValues } from "@/lib/queries/lineup";
import { getTeamById } from "@/lib/queries/teams";
import { CURRENT_SEASON } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, parseDate } from "../../../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return errorResponse("Not found.", 404);
    const team = await getTeamById(pool, id, CURRENT_SEASON);
    if (!team) return errorResponse("No such team in this league.", 404);
    const raw = new URL(req.url).searchParams.get("date");
    const date = raw === null ? team.today : parseDate(raw);
    if (!date) return errorResponse("date must be yyyy-mm-dd", 400);
    const values = await loadValues(pool, team.season);
    return NextResponse.json(await getTeamLineup(pool, team, date, values), { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/teams/:id/lineup", err);
  }
}
