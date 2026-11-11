"use client";

import { useEffect, useRef, useState } from "react";
import type { SensorSample } from "@/lib/types";
import { useLive, type SampleStream } from "./LiveProvider";
import { Wave } from "./Icons";
import { Card, CardHeader } from "./ui";

/**
 * Мэдрэгчийн түүхий дохиог (MPU9250, ~50 Hz) осциллограф шиг шууд зурна.
 * Өгөгдөл SSE "samples" event-ээр ирж, canvas дээр requestAnimationFrame-ээр зурагдана
 * (React re-render хийхгүй тул секундэд 60 кадр ч ачаалалгүй).
 */
const WINDOW_MS = 8000;
const LAG_MS = 300; // багцын хооронд гөлгөр гүйлгэхийн тулд бага зэрэг хоцроож зурна

type Key = "ax" | "ay" | "az" | "gx" | "gy" | "gz" | "mag";
const ACC: { key: Key; label: string; color: string }[] = [
  { key: "ax", label: "aX", color: "#151515" },
  { key: "ay", label: "aY", color: "#a3a3a3" },
  { key: "az", label: "aZ", color: "#8fb0ff" },
  { key: "mag", label: "|a|", color: "#2a61fd" },
];
const GYR: { key: Key; label: string; color: string }[] = [
  { key: "gx", label: "gX", color: "#151515" },
  { key: "gy", label: "gY", color: "#a3a3a3" },
  { key: "gz", label: "gZ", color: "#2a61fd" },
];

const val = (s: SensorSample, k: Key) => (k === "mag" ? Math.hypot(s.ax, s.ay, s.az) : s[k]);

function drawPanel(
  ctx: CanvasRenderingContext2D,
  y0: number,
  h: number,
  w: number,
  samples: SensorSample[],
  tEnd: number,
  series: typeof ACC,
  minRange: number,
  unit: string,
  css: { muted: string; sep: string },
) {
  const tStart = tEnd - WINDOW_MS;
  let r = minRange;
  for (const s of samples) if (s.t >= tStart) for (const { key } of series) r = Math.max(r, Math.abs(val(s, key)));
  r = minRange >= 10 ? Math.ceil((r * 1.1) / 50) * 50 : Math.ceil(r * 1.1 * 2) / 2;
  const yOf = (v: number) => y0 + h / 2 - (v / r) * (h / 2 - 4);
  const xOf = (t: number) => ((t - tStart) / WINDOW_MS) * w;

  ctx.strokeStyle = css.sep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of [-r, -r / 2, 0, r / 2, r]) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  for (let s = 1; s < WINDOW_MS / 1000; s++) {
    const x = Math.round(xOf(tEnd - s * 1000)) + 0.5;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + h);
  }
  ctx.stroke();
  ctx.fillStyle = css.muted;
  ctx.font = "11px -apple-system, system-ui, sans-serif";
  ctx.fillText(`+${r} ${unit}`, 4, y0 + 12);
  ctx.fillText(`−${r}`, 4, y0 + h - 4);

  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  for (const { key, color } of series) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    let started = false;
    for (const s of samples) {
      if (s.t < tStart - 100) continue;
      if (s.t > tEnd + 100) break;
      const x = xOf(s.t);
      const y = yOf(val(s, key));
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }
}

function useScope(stream: React.RefObject<SampleStream>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();

    const frame = () => {
      const st = stream.current;
      const cs = getComputedStyle(cv);
      const css = { muted: cs.getPropertyValue("--muted") || "#8e8e93", sep: cs.getPropertyValue("--sep") || "#ddd" };
      ctx.clearRect(0, 0, w, h);
      if (st.samples.length) {
        const since = Math.min(performance.now() - st.arrivedAt, 1000);
        const tEnd = st.lastT - LAG_MS + since;
        const gap = 10;
        const ph = (h - gap) / 2;
        drawPanel(ctx, 0, ph, w, st.samples, tEnd, ACC, 2, "g", css);
        drawPanel(ctx, ph + gap, ph, w, st.samples, tEnd, GYR, 250, "°/s", css);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [stream]);
  return canvas;
}

const WS_LABEL = { off: "унтраастай", connecting: "холбогдож байна…", open: "холбогдсон", error: "холбогдсонгүй — дахин оролдож байна" } as const;

interface Readout {
  s: SensorSample | null;
  hz: number;
  stale: boolean;
}

export function LiveSensorCard() {
  const { stream, snap, ws } = useLive();
  const [editing, setEditing] = useState(false);
  const [secure, setSecure] = useState(false); // HTTPS (deploy хийсэн) хуудас уу
  useEffect(() => setSecure(window.location.protocol === "https:"), []);
  const [draft, setDraft] = useState("");
  const canvas = useScope(stream);
  const [src, setSrc] = useState<SampleStream["source"]>(null);
  const [ro, setRo] = useState<Readout>({ s: null, hz: 0, stale: true });

  useEffect(() => {
    const id = setInterval(() => {
      const st = stream.current;
      const n = st.samples.length;
      const last = n ? st.samples[n - 1] : null;
      let hz = 0;
      if (n > 1) {
        const from = st.samples.findIndex((x) => x.t >= st.lastT - 2000);
        const span = st.lastT - st.samples[from].t;
        hz = span > 0 ? ((n - 1 - from) * 1000) / span : 0;
      }
      setSrc(st.source);
      setRo({ s: last, hz, stale: !last || performance.now() - st.arrivedAt > 3000 });
    }, 100);
    return () => clearInterval(id);
  }, [stream]);

  const s = ro.s;
  const fmt = (v: number | undefined, d: number) => {
    if (v === undefined) return "—";
    const x = Number(v.toFixed(d)) || 0; // -0 → 0
    return (x >= 0 ? "+" : "") + x.toFixed(d);
  };
  const devName = snap?.device ? (snap.device.simulated ? "DEMO" : snap.device.deviceId) : "—";

  return (
    <Card>
      <CardHeader
        icon={<Wave size={18} />}
        title="Мэдрэгчийн дохио — шууд"
        color="#141414"
        meta={
          <span className="flex items-center gap-1.5">
            <i className={`h-2 w-2 rounded-full ${ro.stale ? "bg-muted" : "animate-pulse bg-[#2a61fd]"}`} />
            {ro.stale ? "Дохио алга" : `${Math.round(ro.hz)} Hz`} · {devName}
          </span>
        }
      />

      <div className="tabular grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ...ACC.map((c) => ({ ...c, v: s ? fmt(val(s, c.key), 2) : "—", unit: "g" })),
          ...GYR.map((c) => ({ ...c, v: s ? fmt(val(s, c.key), 0) : "—", unit: "°/s" })),
        ].map((c) => (
          <div key={c.key} className="rounded-xl bg-fill px-3 py-2">
            <p className="flex items-center gap-1.5 text-[12px] text-muted">
              <i className="h-2 w-2 rounded-full" style={{ background: c.color }} />
              {c.label}
            </p>
            <p className="text-[18px] font-semibold leading-tight">
              {c.v} <span className="text-[12px] font-medium text-muted">{c.unit}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-between text-[12px] text-muted">
        <span>Хурдатгал (g) · дээр</span>
        <span>Эргэлт (°/s) · доор · сүүлийн 8 сек</span>
      </div>
      <canvas ref={canvas} className="mt-1 block h-72 w-full" />

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-sep pt-3 text-[12px] text-muted">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            src === "ws" && !ro.stale ? "bg-[#2a61fd]/10 text-[#2a61fd]" : "bg-fill text-muted"
          }`}
        >
          {src === "ws" && !ro.stale ? "ESP32 → веб шууд (WebSocket)" : src === "sse" && !ro.stale ? "Сервероор дамжиж" : "Холболтгүй"}
        </span>
        <span>
          {secure
            ? "Интернэтээр: ESP32 → сервер → веб (≈0.5 сек)"
            : ws.url
              ? `${ws.url} · ${WS_LABEL[ws.state]}`
              : "ESP32-ийн IP хүлээж байна"}
        </span>
        {secure ? null : editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              ws.setManual(draft);
              setEditing(false);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="192.168.1.50 эсвэл motioncare.local"
              className="w-60 rounded-lg bg-fill px-2 py-1 text-ink outline-none"
            />
            <button className="rounded-lg bg-[#151515] px-2 py-1 font-medium text-white">Хадгалах</button>
          </form>
        ) : (
          <button
            className="text-[#2a61fd] hover:opacity-70"
            onClick={() => {
              setDraft(ws.manual);
              setEditing(true);
            }}
          >
            IP өөрчлөх
          </button>
        )}
      </div>
    </Card>
  );
}
