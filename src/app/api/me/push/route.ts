// GET    /api/me/push  { publicKey }: null when the server has no VAPID keys (alerts off)
// PUT    /api/me/push  turn injury alerts on for this browser: body { subscription }; sends a
//                      confirmation notification unless ?quiet=1 (the menu re-saving an existing one)
// DELETE /api/me/push  turn them off for this browser: body { endpoint }
// 401 signed out, 400 bad input, 503 alerts not configured.
// Contract: PushConfigResponse / PushSubscribeRequest / PushUnsubscribeRequest in src/lib/types.ts.
// Logic: src/lib/push/send.ts. Alerts go out from the worker's injuries task.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { deleteSubscription, saveSubscription, sendToSubscription, toBrowserSubscription, vapidPublicKey } from "@/lib/push/send";
import type { PushConfigResponse } from "@/lib/types";
import { NO_STORE, errorResponse, handleError, sessionUserId } from "../../team/lineup/shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const body: PushConfigResponse = { publicKey: vapidPublicKey() };
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function PUT(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in to turn on injury alerts.", 401);
    if (!vapidPublicKey()) return errorResponse("Injury alerts aren't set up on this server.", 503);
    const body = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
    const sub = toBrowserSubscription(body?.subscription);
    if (!sub) return errorResponse("Bad subscription.", 400);
    await saveSubscription(pool, id, sub, req.headers.get("user-agent"));
    if (new URL(req.url).searchParams.get("quiet") === "1") return new NextResponse(null, { status: 204, headers: NO_STORE });
    // Best effort: shows the setup works end to end.
    await sendToSubscription(pool, sub.endpoint, {
      title: "Injury alerts are on",
      body: "You'll get a notification here when a player on your roster gets a worse injury status or is healthy again.",
      tag: "push-welcome",
      url: "/my-team",
    }).catch((err) => console.error("push confirmation failed", err));
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    return handleError("PUT /api/me/push", err);
  }
}

export async function DELETE(req: Request) {
  try {
    const id = await sessionUserId();
    if (id === null) return errorResponse("Sign in first.", 401);
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== "string") return errorResponse("Missing endpoint.", 400);
    await deleteSubscription(pool, id, body.endpoint);
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    return handleError("DELETE /api/me/push", err);
  }
}
