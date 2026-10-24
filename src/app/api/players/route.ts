// STUB: serves sample data. The data workstream replaces this with the
// season-averages query (contract: PlayersResponse in src/lib/types.ts).
import { NextResponse } from "next/server";
import { samplePlayersResponse } from "@/lib/fixtures";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage")) || 50));
  return NextResponse.json(samplePlayersResponse(page, perPage));
}
