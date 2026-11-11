import { cloudEnabled } from "./cloud";
import type { Activity, SensorSample } from "../types";
import { ingest, startOfToday } from "./pipeline";
import { getRepository } from "./store";

/**
 * Demo горим: бодит ESP32 холбогдоогүй үед MPU6050-тэй төстэй дохио үүсгэж,
 * яг бодит төхөөрөмж шиг /api/ingest урсгалаар оруулна.
 * SIMULATE=false болгоход бүрэн унтарна.
 */
const DEVICE_ID = "demo-esp32s3";
const HZ = 50;
const BASE = { lat: 47.9184, lng: 106.9177 };

const PLAN: { a: Activity; sec: [number, number] }[] = [
  { a: "sitting", sec: [25, 45] },
  { a: "standing", sec: [10, 20] },
  { a: "walking", sec: [25, 40] },
  { a: "running", sec: [12, 20] },
  { a: "walking", sec: [15, 25] },
  { a: "standing", sec: [8, 15] },
  { a: "sitting", sec: [20, 30] },
  { a: "lying", sec: [15, 25] },
  { a: "standing", sec: [8, 12] },
  { a: "walking", sec: [15, 20] },
  { a: "fall", sec: [6, 6] },
  { a: "lying", sec: [8, 10] },
];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const n = (s: number) => (Math.random() * 2 - 1) * s;

function sample(a: Activity, t: number, phase: number): SensorSample {
  const w = 2 * Math.PI * phase;
  switch (a) {
    case "walking":
      return { t, ax: 0.15 * Math.sin(w * 1.9) + n(0.05), ay: 0.98 + 0.42 * Math.sin(w * 1.9 * 2) + n(0.08), az: 0.12 + 0.2 * Math.cos(w * 1.9) + n(0.05), gx: 25 * Math.sin(w * 1.9) + n(5), gy: n(8), gz: 12 * Math.cos(w * 1.9) + n(4) };
    case "running":
      return { t, ax: 0.35 * Math.sin(w * 2.8) + n(0.15), ay: 1.0 + 1.25 * Math.sin(w * 2.8 * 2) + n(0.2), az: 0.2 + 0.45 * Math.cos(w * 2.8) + n(0.12), gx: 70 * Math.sin(w * 2.8) + n(15), gy: n(20), gz: 35 * Math.cos(w * 2.8) + n(10) };
    case "standing":
      return { t, ax: 0.05 + n(0.02), ay: 0.99 + n(0.02), az: 0.08 + n(0.02), gx: n(1.5), gy: n(1.5), gz: n(1.5) };
    case "sitting":
      return { t, ax: 0.08 + n(0.02), ay: 0.72 + n(0.02), az: 0.66 + n(0.02), gx: n(1), gy: n(1), gz: n(1) };
    case "lying":
      return { t, ax: 0.1 + n(0.02), ay: 0.06 + n(0.02), az: 0.99 + n(0.02), gx: n(0.8), gy: n(0.8), gz: n(0.8) };
    case "fall": {
      // 0–1 сек: хэвийн, 1–1.4 сек: цохилт, дараа нь хэвтээ хөдөлгөөнгүй
      if (phase < 1) return sample("standing", t, phase);
      if (phase < 1.4) return { t, ax: n(2), ay: 0.4 + n(2.2), az: 2.4 + n(1.2), gx: n(250), gy: n(250), gz: n(250) };
      return sample("lying", t, phase);
    }
  }
}

interface SimState {
  timer: ReturnType<typeof setInterval>;
  idx: number;
  left: number;
  phase: number;
}

const g = globalThis as unknown as { __sim?: SimState };

function backfill() {
  const repo = getRepository();
  const now = Date.now();
  const start = Math.max(startOfToday(now), now - 12 * 3600_000);
  const day: [Activity, number, number][] = [
    ["lying", 20, 40], ["standing", 5, 15], ["walking", 8, 25], ["sitting", 30, 80],
    ["standing", 5, 12], ["walking", 5, 20], ["running", 0, 12], ["sitting", 20, 70], ["walking", 4, 15],
  ];
  let t = start;
  let i = 0;
  while (t < now - 5 * 60_000) {
    const [a, lo, hi] = day[i++ % day.length];
    const dur = rnd(lo, hi) * 60_000;
    if (dur < 60_000) continue;
    repo.pushSegment(DEVICE_ID, { activity: a, start: t, end: Math.min(t + dur, now - 5 * 60_000) });
    t += dur;
  }
}

export function ensureSimulator() {
  // Үүлэн (Vercel) горимд serverless тул setInterval ажиллахгүй → demo унтраана
  if (process.env.SIMULATE === "false" || g.__sim || cloudEnabled) return;
  const repo = getRepository();
  repo.upsertDevice({ deviceId: DEVICE_ID, name: "Demo төхөөрөмж", simulated: true, sampleRateHz: HZ, battery: 86, rssi: -58 });
  backfill();
  const st: SimState = { idx: 0, left: rnd(...PLAN[0].sec), phase: 0, timer: undefined as never };
  let battery = 86;
  st.timer = setInterval(() => {
    if (repo.listDevices().some((d) => !d.simulated && Date.now() - d.lastSeen < 10_000)) return;
    const a = PLAN[st.idx].a;
    const now = Date.now();
    const samples: SensorSample[] = [];
    const per = HZ / 2;
    for (let k = 0; k < per; k++) {
      samples.push(sample(a, now - (per - k) * (1000 / HZ), st.phase));
      st.phase += 1 / HZ;
    }
    battery = Math.max(5, battery - 0.0005);
    const moving = a === "walking" || a === "running";
    const gps = repo.getGps(DEVICE_ID) ?? { ...BASE, t: now };
    void ingest(
      {
        deviceId: DEVICE_ID,
        samples,
        battery: Math.round(battery),
        rssi: -55 - Math.round(Math.random() * 8),
        gps: { lat: gps.lat + (moving ? n(0.00004) : 0), lng: gps.lng + (moving ? n(0.00006) : 0), accuracy: 2.5 },
      },
      { simulated: true },
    );
    st.left -= 0.5;
    if (st.left <= 0) {
      st.idx = (st.idx + 1) % PLAN.length;
      st.left = rnd(...PLAN[st.idx].sec);
      st.phase = 0;
    }
  }, 500);
  g.__sim = st;
}
