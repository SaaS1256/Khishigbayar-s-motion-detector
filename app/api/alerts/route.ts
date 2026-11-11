import { NextResponse } from "next/server";
import { bus } from "@/lib/server/pipeline";
import { getRepository } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/alerts  { deviceId, id }
 * Асран хамгаалагч анхааруулгатай танилцсаныг тэмдэглэнэ. Веб самбар SSE-ээр шууд шинэчлэгдэнэ.
 */
export async function POST(req: Request) {
  let body: { deviceId?: string; id?: string };
  try {
    body = (await req.json()) as { deviceId?: string; id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!body?.deviceId || !body.id) {
    return NextResponse.json({ ok: false, error: "deviceId, id шаардлагатай" }, { status: 400 });
  }
  const ok = getRepository().ackAlert(body.deviceId, body.id);
  if (ok) bus.emit("update", body.deviceId);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
