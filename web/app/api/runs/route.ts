import { NextResponse } from "next/server";
import { listRuns } from "@/lib/stats";

// Read-only. The worker writes; this route only reports.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}