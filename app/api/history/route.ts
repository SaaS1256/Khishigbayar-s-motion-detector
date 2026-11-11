import { NextResponse } from "next/server";
import { historyDeviceId, startOfToday } from "@/lib/server/pipeline";
import { ensureSimulator } from "@/lib/server/simulator";
import { getRepository } from "@/lib/server/store";
import { cloudEnabled, cloudHistory } from "@/lib/server/cloud";

export const dynamic = "force-dynamic";

/**
 * GET /api/history?device=<id>
 *   hours    — өнөөдрийн цаг тутмын хуваарилалт
 *   segments — өнөөдрийн хэсгүүд
 *   days     — сүүлийн 30 өдрийн өдөр тутмын нийлбэр (ангилал тус бүрийн ms)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (cloudEnabled) return NextResponse.json({ days: [], ...(await cloudHistory(url.searchParams.get("device"))) });
  const device = url.searchParams.get("device") ?? historyDeviceId();
  if (!device) return NextResponse.json({ hours: [], segments: [], days: [] });
  const repo = getRepository();
  const day = startOfToday();
  const now = Date.now();
  const hours = Array.from({ length: 24 }, (_, h) => {
    const a = day + h * 3600_000;
    return { hour: h, durations: a > now ? null : repo.durations(device, a, Math.min(a + 3600_000, now)) };
  });
  return NextResponse.json({
    deviceId: device,
    hours,
    segments: repo.segments(device, day),
    alerts: repo.alerts(device, 50),
    days: repo.daily(device, 30),
  });
}
