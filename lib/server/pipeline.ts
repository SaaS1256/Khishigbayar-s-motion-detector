import { EventEmitter } from "node:events";
import { ACTIVITIES } from "../activities";
import type { Activity, DeviceResponse, IngestPayload, Prediction, Snapshot } from "../types";
import { createClassifier, type Classifier } from "./classifier";
import { getRepository, type MemoryRepository } from "./store";

// ML үйлчилгээ рүү сүүлийн 3 сек-ийг илгээнэ. service.py загварын сурсан уртаар (train2.py --window → model.window_)
// өөрөө тайрдаг тул цонхны уртыг зөвхөн train2.py-д солиход хангалттай: сургалт, inference хэзээ ч зөрөхгүй.
const WINDOW_MS = 3000;
const OFFLINE_MS = 10_000;

/**
 * Тогтворжуулалт: шинэ ангилал доорх хугацаанд тасралтгүй гарсны дараа л дэлгэц, OLED-д солигдоно.
 * Ингэснээр суух/босох үеийн богино буруу ангилал (жишээ нь бөхийлтийг "гүйх" гэж) харагдахгүй.
 * ML "шилжилт" (transition) гэж үзсэн үед ангиллыг солихгүй.
 */
const HOLD_MS: Record<Activity, number> = { running: 1000, walking: 600, sitting: 500, standing: 500, lying: 500, fall: 0 };
const TRANSITION_P = 0.5;
/**
 * Уналтын баталгаажуулалт (худал анхааруулгаас сэргийлнэ):
 *  1) ML-ийн харсан хэсэгт 2 g-ээс их цохилт байх ёстой;
 *  2) дараагийн 1.5 сек-д алхах / гүйх / зогсох гарвал хүн босоод явсан гэж үзэж цуцална.
 * Баталгаажсан уналт нь хүн босох (зогсох/алхах) хүртэл "Уналт" хэвээр үлдэнэ.
 */
const FALL_MIN_G = 2.0;
const FALL_CONFIRM_MS = 1500;
const UPRIGHT: Activity[] = ["walking", "running", "standing"];

interface Stab {
  stable: Activity | null;
  cand: Activity | null;
  since: number;
  fallAt: number | null;
  fallConf: number;
}

const g = globalThis as unknown as {
  __bus?: EventEmitter;
  __clf?: Classifier;
  __lastFall?: Map<string, number>;
  __stab2?: Map<string, Stab>;
};
export const bus = (g.__bus ??= new EventEmitter().setMaxListeners(100));
const classifier = (g.__clf ??= createClassifier());
export const lastFall = (g.__lastFall ??= new Map<string, number>());
const stabState = (g.__stab2 ??= new Map<string, Stab>());

function stabilize(p: Prediction, peakG: number): { pred: Prediction; fallConfirmed: boolean } {
  const st: Stab = stabState.get(p.deviceId) ?? { stable: null, cand: null, since: 0, fallAt: null, fallConf: 0 };
  const raw = p.activity;
  let fallConfirmed = false;

  if (raw === "fall" && peakG >= FALL_MIN_G && st.fallAt === null && st.stable !== "fall") {
    st.fallAt = p.t;
    st.fallConf = p.confidence;
  }
  if (st.fallAt !== null) {
    if (UPRIGHT.includes(raw)) {
      st.fallAt = null;
    } else if (p.t - st.fallAt >= FALL_CONFIRM_MS) {
      st.stable = "fall";
      st.cand = null;
      st.fallAt = null;
      fallConfirmed = true;
    }
  } else if (raw !== "fall" && (p.transition ?? 0) < TRANSITION_P) {
    if (st.stable === null) {
      st.stable = raw;
    } else if (raw === st.stable || (st.stable === "fall" && !UPRIGHT.includes(raw))) {
      st.cand = null; // уналтын дараа хэвтэх/суух → "Уналт" хэвээр
    } else {
      if (raw !== st.cand) {
        st.cand = raw;
        st.since = p.t;
      }
      if (p.t - st.since >= HOLD_MS[raw]) {
        st.stable = raw;
        st.cand = null;
      }
    }
  }
  stabState.set(p.deviceId, st);
  const activity: Activity = st.stable ?? (raw === "fall" ? "lying" : raw);
  const confidence = activity === "fall" ? st.fallConf : activity === raw ? p.confidence : (p.scores[activity] ?? p.confidence);
  return { pred: { ...p, activity, confidence }, fallConfirmed };
}

export async function ingest(
  p: IngestPayload,
  opts: { simulated?: boolean } = {},
  repo: MemoryRepository = getRepository(),
): Promise<Prediction | null> {
  const now = Date.now();
  repo.upsertDevice({
    deviceId: p.deviceId,
    online: true,
    lastSeen: now,
    battery: p.battery,
    rssi: p.rssi,
    ip: p.ip,
    simulated: opts.simulated ?? false,
    name: opts.simulated ? "Demo төхөөрөмж" : p.deviceId,
  });
  repo.addSamples(p.deviceId, p.samples);
  bus.emit("samples", p.deviceId, p.samples);
  if (p.gps) repo.setGps(p.deviceId, { ...p.gps, t: p.gps.t ?? now });

  const win = repo.getWindow(p.deviceId, WINDOW_MS);
  const raw = await classifier.predict(p.deviceId, win);
  if (!raw) return null;
  // Уналтын цохилтыг ML-ийн харсан хэсэгт (сүүлийн ~1.5 сек) хайна
  const peakG = win.slice(-75).reduce((m, s) => Math.max(m, Math.hypot(s.ax, s.ay, s.az)), 0);
  const { pred, fallConfirmed } = stabilize(raw, peakG);
  repo.addPrediction(pred);

  if (fallConfirmed && now - (lastFall.get(p.deviceId) ?? 0) > 30_000) {
    lastFall.set(p.deviceId, now);
    repo.addAlert({
      deviceId: p.deviceId,
      t: now,
      kind: "fall",
      message: "Уналт илэрлээ",
      gps: repo.getGps(p.deviceId) ?? undefined,
    });
  }
  bus.emit("update", p.deviceId);
  return pred;
}

export function toDeviceResponse(pred: Prediction | null): DeviceResponse {
  return {
    ok: true,
    activity: pred?.activity ?? null,
    label: pred ? ACTIVITIES[pred.activity].short : null,
    confidence: pred ? Math.round(pred.confidence * 100) / 100 : null,
    alert: pred?.activity === "fall",
  };
}

/** Веб дээр харуулах төхөөрөмж: сүүлд идэвхтэй байсан бодит төхөөрөмж, байхгүй бол demo */
export function activeDeviceId(repo: MemoryRepository = getRepository()): string | null {
  const devices = repo.listDevices();
  if (!devices.length) return null;
  const real = devices.filter((d) => !d.simulated).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (real && Date.now() - real.lastSeen < OFFLINE_MS) return real.deviceId;
  return devices.sort((a, b) => b.lastSeen - a.lastSeen)[0].deviceId;
}

export function historyDeviceId(): string | null {
  const real = getRepository()
    .listDevices()
    .filter((d) => !d.simulated)
    .sort((a, b) => b.lastSeen - a.lastSeen)[0];
  return real?.deviceId ?? activeDeviceId();
}

export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildSnapshot(deviceId = activeDeviceId(), repo: MemoryRepository = getRepository()): Snapshot {
  const now = Date.now();
  if (!deviceId) {
    return { now, device: null, current: null, currentSince: null, signal: [], today: { sitting: 0, standing: 0, walking: 0, running: 0, lying: 0, fall: 0 }, timeline: [], alerts: [], gps: null };
  }
  const dev = repo.getDevice(deviceId)!;
  const device = { ...dev, online: now - dev.lastSeen < OFFLINE_MS };
  const since = startOfToday(now);
  const segments = repo.segments(deviceId, since);
  const last = segments[segments.length - 1];
  const raw = repo.getWindow(deviceId, 10_000);
  const step = Math.max(1, Math.floor(raw.length / 200));
  const signal = raw
    .filter((_, i) => i % step === 0)
    .map((s) => ({ t: s.t, mag: Math.hypot(s.ax, s.ay, s.az), ax: s.ax, ay: s.ay, az: s.az }));
  return {
    now,
    device,
    current: repo.latestPrediction(deviceId),
    currentSince: last ? last.start : null,
    signal,
    today: repo.durations(deviceId, since, now),
    timeline: segments.slice(-60),
    alerts: repo.alerts(deviceId, 10),
    gps: repo.getGps(deviceId),
  };
}
