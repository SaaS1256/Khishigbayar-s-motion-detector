import { cloudEnabled } from "@/lib/server/cloud";
import { activeDeviceId, bus, buildSnapshot } from "@/lib/server/pipeline";
import { getRepository } from "@/lib/server/store";
import type { SensorSample } from "@/lib/types";
import { ensureSimulator } from "@/lib/server/simulator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events:
 *   event "message" — хураангуй төлөв (ангилал, түүх ...) ~250 мс тутам
 *   event "samples" — мэдрэгчийн түүхий утгууд, төхөөрөмжөөс ирэнгүүт шууд
 */
export async function GET(req: Request) {
  // Үүлэн (Vercel) горимд серверүүд санах ой хуваалцахгүй тул SSE биш, /api/live-аар асууна
  if (cloudEnabled) {
    return new Response("event: mode\ndata: poll\n\n", {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
    });
  }
  ensureSimulator();
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let pending = false;
      const send = () => {
        pending = false;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(buildSnapshot())}\n\n`));
        } catch {
          cleanup();
        }
      };
      const onUpdate = () => {
        if (!pending) {
          pending = true;
          setTimeout(send, 250);
        }
      };
      const sendSamples = (deviceId: string, samples: SensorSample[]) => {
        try {
          controller.enqueue(enc.encode(`event: samples\ndata: ${JSON.stringify({ deviceId, samples })}\n\n`));
        } catch {
          cleanup();
        }
      };
      const onSamples = (deviceId: string, samples: SensorSample[]) => {
        if (deviceId === activeDeviceId()) sendSamples(deviceId, samples);
      };
      const heartbeat = setInterval(send, 2000);
      bus.on("update", onUpdate);
      bus.on("samples", onSamples);
      send();
      const dev = activeDeviceId();
      if (dev) sendSamples(dev, getRepository().getWindow(dev, 8000));
      cleanup = () => {
        clearInterval(heartbeat);
        bus.off("update", onUpdate);
        bus.off("samples", onSamples);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
