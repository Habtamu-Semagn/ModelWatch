import { NextResponse } from "next/server";
import { runDetail } from "@/lib/stats";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const detail = await runDetail(params.id);
    if (!detail) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}