// GET  /api/team/transactions?add=<playerId>  roster and limits for the add/drop sheet
// POST /api/team/transactions  { addPlayerId?, dropPlayerId? }  add, drop, or add/drop
// The signed-in user's team. Contract: RosterMovesContext, RosterMoveRequest
// and RosterMoveResult in src/lib/types.ts. Rules: src/lib/queries/transactions.ts.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { getUserTeam, loadValues, type TeamContext } from "@/lib/queries/lineup";
import { getRosterMovesContext, runRosterMove } from "@/lib/queries/transactions";
import { CURRENT_SEASON } from "@/lib/types";
import { NO_STORE, errorResponse, handleError } from "../lineup/shared";

export const dynamic = "force-dynamic";

/** Like requireTeam, plus the user id (transactions record who made the move). */
async function requireManager(): Promise<{ team: TeamContext; userId: number } | NextResponse> {
  const session = await getSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return errorResponse("Sign in to manage your team.", 401);
  const team = await getUserTeam(pool, session.user.id, CURRENT_SEASON);
  if (!team) return errorResponse("You don't have a team in this league.", 404);
  return { team, userId: session.user.id };
}

const optionalId = (v: unknown) => (v === undefined || v === null ? null : Number.isInteger(v) && (v as number) > 0 ? (v as number) : NaN);

export async function GET(req: Request) {
  try {
    const who = await requireManager();
    if (who instanceof NextResponse) return who;
    const raw = new URL(req.url).searchParams.get("add");
    const add = raw === null ? null : Number(raw);
    if (add !== null && !(Number.isInteger(add) && add > 0)) return errorResponse("add must be a player id", 400);
    const values = await loadValues(pool, who.team.season);
    const body = await getRosterMovesContext(pool, who.team, values, add);
    if (!body) return errorResponse("Player not found.", 404);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/team/transactions", err);
  }
}

export async function POST(req: Request) {
  try {
    const who = await requireManager();
    if (who instanceof NextResponse) return who;
    const body = (await req.json().catch(() => null)) as { addPlayerId?: unknown; dropPlayerId?: unknown } | null;
    const addPlayerId = optionalId(body?.addPlayerId);
    const dropPlayerId = optionalId(body?.dropPlayerId);
    if (Number.isNaN(addPlayerId) || Number.isNaN(dropPlayerId)) {
      return errorResponse("addPlayerId and dropPlayerId must be player ids", 400);
    }
    const values = await loadValues(pool, who.team.season);
    const result = await runRosterMove(pool, who.team, who.userId, values, { addPlayerId, dropPlayerId });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return handleError("POST /api/team/transactions", err);
  }
}
