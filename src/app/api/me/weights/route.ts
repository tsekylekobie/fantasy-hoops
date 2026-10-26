// GET /api/me/weights   your punt weights (the defaults when signed out or never saved)
// PUT /api/me/weights   save them: body { weights: CategoryWeights }; 401 signed out, 400 bad input.
// Contract: WeightsResponse in src/lib/types.ts. Logic: src/lib/queries/weights.ts.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { toWeights } from "@/lib/queries/params";
import { getWeights, saveWeights } from "@/lib/queries/weights";
import { DEFAULT_WEIGHTS, MAX_WEIGHT, type WeightsResponse } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, sessionUserId } from "../../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const id = await sessionUserId();
    const body: WeightsResponse = id === null
      ? { weights: { ...DEFAULT_WEIGHTS }, signedIn: false }
      : { weights: await getWeights(pool, id), signedIn: true };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    return handleError("GET /api/me/weights", err);
  }
}

export async function PUT(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in to save your weights.", 401);
    const body = (await req.json().catch(() => null)) as { weights?: unknown } | null;
    const weights = toWeights(body?.weights);
    if (!weights) return errorResponse(`Every category needs a weight from 0 to ${MAX_WEIGHT}.`, 400);
    await saveWeights(pool, id, weights);
    const res: WeightsResponse = { weights, signedIn: true };
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/me/weights", err);
  }
}
