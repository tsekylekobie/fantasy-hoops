// GET /api/teams/:id/logo?v=<version>  the team's logo image (404 without one).
// Links carry ?v= (fantasy_teams.logo_updated_at), so a given URL never changes
// and can be cached for good (privately: signed in only, as league data is private); a new upload gets a new URL.
import { pool } from "@/lib/db";
import { getTeamLogo } from "@/lib/queries/teamProfile";
import { errorResponse, handleError, sessionUserId } from "../../../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if ((await sessionUserId()) === null) return errorResponse("Sign in to see team logos.", 401);
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return errorResponse("Not found.", 404);
    const logo = await getTeamLogo(pool, id);
    if (!logo) return errorResponse("This team has no logo.", 404);
    const versioned = new URL(req.url).searchParams.get("v") === String(logo.updatedAt.getTime());
    return new Response(new Uint8Array(logo.bytes), {
      headers: {
        "Content-Type": logo.type,
        "Content-Length": String(logo.bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, max-age=60",
        "Last-Modified": logo.updatedAt.toUTCString(),
      },
    });
  } catch (err) {
    return handleError("GET /api/teams/:id/logo", err);
  }
}
