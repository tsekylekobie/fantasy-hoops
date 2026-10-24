// STUB: serves sample data. The data workstream replaces this with the
// player-detail query (contract: PlayerDetailResponse in src/lib/types.ts).
import { NextResponse } from "next/server";
import { samplePlayerDetail } from "@/lib/fixtures";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = samplePlayerDetail(Number(id));
  if (!detail) return NextResponse.json({ error: "Player not found" }, { status: 404 });
  return NextResponse.json(detail);
}
