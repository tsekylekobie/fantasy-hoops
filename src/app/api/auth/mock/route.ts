// POST /api/auth/mock (form: email, name, next) — local-dev stand-in for
// Google. 404s unless mock auth is enabled, which it never is in production.
import { NextResponse } from "next/server";
import { mockAuthEnabled, safeNext } from "@/lib/auth/config";
import { linkMemberships } from "@/lib/auth/members";
import { startSession, upsertUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!mockAuthEnabled()) return new NextResponse("Not found", { status: 404 });

  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim() || email.split("@")[0];
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return new NextResponse("Enter a valid email", { status: 400 });

  const userId = await upsertUser({ googleSub: `mock:${email}`, email, name, pictureUrl: null });
  await linkMemberships(pool, userId, email);
  // 303 so the browser follows with a GET.
  const res = NextResponse.redirect(new URL(safeNext(String(form.get("next") ?? "")), req.url), 303);
  await startSession(res, userId, req.headers.get("user-agent"));
  return res;
}
