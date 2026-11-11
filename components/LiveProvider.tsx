"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { SensorSample, Snapshot } from "@/lib/types";

type Conn = "connecting" | "live" | "reconnecting";
export type WsState = "off" | "connecting" | "open" | "error";

const WS_STORAGE_KEY = "motioncare.esp32ws";
const WS_PORT = 81;

/** Мэдрэгчийн түүхий утгуудын хөдөлгөөнт буфер (React state биш — секундэд 50 удаа шинэчлэгдэнэ) */
export interface SampleStream {
  deviceId: string | null;
  samples: SensorSample[];
  arrivedAt: number;
  lastT: number;
  source: "ws" | "sse" | null;
}

const BUFFER_MS = 12_000;

interface LiveCtx {
  snap: Snapshot | null;
  conn: Conn;
  stream: React.RefObject<SampleStream>;
  ws: { state: WsState; url: string | null; manual: string; setManual: (v: string) => void };
}
const Ctx = createContext<LiveCtx | null>(null);

function pushSamples(st: SampleStream, id: string, source: "ws" | "sse", samples: SensorSample[]) {
  if (!samples.length) return;
  if (st.deviceId !== id) {
    st.deviceId = id;
    st.samples = [];
  }
  st.source = source;
  const lastKnown = st.samples.length ? st.samples[st.samples.length - 1].t : -Infinity;
  for (const s of samples) if (s.t > lastKnown) st.samples.push(s);
  if (!st.samples.length) return;
  const lastT = st.samples[st.samples.length - 1].t;
  const cut = st.samples.findIndex((s) => s.t >= lastT - BUFFER_MS);
  if (cut > 0) st.samples.splice(0, cut);
  st.lastT = lastT;
  st.arrivedAt = performance.now();
}

/**
 * Серверээс SSE (/api/stream)-ээр:
 *   • хураангуй төлөв (snapshot) — ангилал, түүх
 *   • мэдрэгчийн түүхий утга ("samples" event) — ирэнгүүт шууд
 * SSE тасарвал /api/snapshot-ийг 2 сек тутам асууж үргэлжлүүлнэ.
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const stream = useRef<SampleStream>({ deviceId: null, samples: [], arrivedAt: 0, lastT: 0, source: null });
  const wsAlive = useRef(0);
  const [wsState, setWsState] = useState<WsState>("off");
  const [manual, setManualState] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const startPolling = () => {
      if (poll.current) return;
      poll.current = setInterval(async () => {
        try {
          const r = await fetch("/api/snapshot", { cache: "no-store" });
          if (r.ok) setSnap(await r.json());
        } catch {}
      }, 2000);
    };
    const stopPolling = () => {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
    };

    const onSamples = (e: MessageEvent) => {
      // ESP32-оос шууд WebSocket ажиллаж байвал серверээр дамжсан (хоцорсон) өгөгдлийг алгасна
      if (performance.now() - wsAlive.current < 1500) return;
      const { deviceId, samples } = JSON.parse(e.data) as { deviceId: string; samples: SensorSample[] };
      pushSamples(stream.current, "sse:" + deviceId, "sse", samples);
    };

    // Үүлэн (Vercel) горим: /api/live-аас 0.5 сек тутам хураангуй төлөв + шинэ хэмжилт авна
    let cloudTimer: ReturnType<typeof setTimeout> | null = null;
    let cloudDevice: string | null = null;
    const cloudPoll = async () => {
      if (closed) return;
      const st = stream.current;
      const since = st.source === "sse" && st.deviceId === "sse:" + cloudDevice ? st.lastT : 0;
      try {
        const q = new URLSearchParams({ since: String(since) });
        if (cloudDevice) q.set("device", cloudDevice);
        const r = await fetch(`/api/live?${q}`, { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { deviceId: string | null; snap: Snapshot; samples: SensorSample[] };
          cloudDevice = j.deviceId;
          setSnap(j.snap);
          setConn("live");
          if (j.deviceId && performance.now() - wsAlive.current >= 1500) pushSamples(st, "sse:" + j.deviceId, "sse", j.samples);
        } else setConn("reconnecting");
      } catch {
        setConn("reconnecting");
      }
      cloudTimer = setTimeout(cloudPoll, 500);
    };

    const connect = () => {
      es = new EventSource("/api/stream");
      es.addEventListener("mode", (e) => {
        if ((e as MessageEvent).data !== "poll") return;
        es?.close();
        es = null;
        stopPolling();
        if (!cloudTimer) void cloudPoll();
      });
      es.onopen = () => {
        setConn("live");
        stopPolling();
      };
      es.onmessage = (e) => {
        setSnap(JSON.parse(e.data));
        setConn("live");
      };
      es.addEventListener("samples", onSamples);
      es.onerror = () => {
        if (cloudTimer) {
          es?.close();
          return; // үүлэн горимд SSE хэрэглэхгүй
        }
        setConn("reconnecting");
        startPolling();
        es?.close();
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      stopPolling();
      if (cloudTimer) clearTimeout(cloudTimer);
    };
  }, []);

  useEffect(() => {
    try {
      setManualState(localStorage.getItem(WS_STORAGE_KEY) ?? "");
    } catch {}
  }, []);
  const setManual = (v: string) => {
    setManualState(v);
    try {
      if (v) localStorage.setItem(WS_STORAGE_KEY, v);
      else localStorage.removeItem(WS_STORAGE_KEY);
    } catch {}
  };
  const devIp = snap?.device && !snap.device.simulated ? snap.device.ip : undefined;
  // HTTPS хуудаснаас (жишээ нь Vercel) ws:// руу хөтөч холбогдохыг хориглодог → зөвхөн локал (http) үед
  const httpPage = typeof window !== "undefined" && window.location.protocol === "http:";
  const wsUrl = httpPage ? (normalizeWs(manual) ?? (devIp ? `ws://${devIp}:${WS_PORT}` : null)) : null;

  useEffect(() => {
    if (!wsUrl) {
      setWsState("off");
      return;
    }
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;
    const open = () => {
      setWsState("connecting");
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        attempt = 0;
        setWsState("open");
      };
      ws.onmessage = (e) => {
        let msg: SensorSample | SensorSample[];
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const list = Array.isArray(msg) ? msg : [msg];
        const samples = list.filter((s) => typeof s?.t === "number" && typeof s.ax === "number");
        if (!samples.length) return;
        wsAlive.current = performance.now();
        pushSamples(stream.current, "ws:" + wsUrl, "ws", samples);
      };
      ws.onclose = () => {
        if (closed) return;
        setWsState("error");
        timer = setTimeout(open, Math.min(5000, 500 * 2 ** attempt++));
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [wsUrl]);

  return (
    <Ctx.Provider value={{ snap, conn, stream, ws: { state: wsState, url: wsUrl, manual, setManual } }}>
      {children}
    </Ctx.Provider>
  );
}

export const useLive = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive must be used inside LiveProvider");
  return v;
};

function normalizeWs(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (/^wss?:\/\//.test(t)) return t;
  return /:\d+$/.test(t) ? `ws://${t}` : `ws://${t}:${WS_PORT}`;
}
