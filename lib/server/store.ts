import fs from "node:fs";
import path from "node:path";
import { emptyDurations } from "../activities";
import type { Activity, Alert, DeviceStatus, GpsFix, Prediction, SensorSample, Segment } from "../types";

/**
 * Өгөгдлийн агуулахын гэрээ. Санах ойд (in-memory) ажиллаж, бодит төхөөрөмжийн түүхийг
 * (сегмент, анхааруулга) .data/history.json файлд 10 сек тутам хадгална → сервер дахин асахад устахгүй.
 * PostgreSQL / TimescaleDB / MongoDB руу шилжихдээ ижил интерфейсийг хэрэгжүүлсэн
 * шинэ класс бичээд getRepository()-г солиход хангалттай.
 */
export interface Repository {
  upsertDevice(d: Partial<DeviceStatus> & { deviceId: string }): DeviceStatus;
  getDevice(deviceId: string): DeviceStatus | undefined;
  listDevices(): DeviceStatus[];
  addSamples(deviceId: string, samples: SensorSample[]): void;
  getWindow(deviceId: string, ms: number): SensorSample[];
  addPrediction(p: Prediction): void;
  latestPrediction(deviceId: string): Prediction | null;
  segments(deviceId: string, since: number): Segment[];
  setGps(deviceId: string, fix: GpsFix): void;
  getGps(deviceId: string): GpsFix | null;
  addAlert(a: Omit<Alert, "id" | "acknowledged">): Alert;
  alerts(deviceId: string, limit?: number): Alert[];
  ackAlert(deviceId: string, id: string): boolean;
  durations(deviceId: string, since: number, until: number): Record<Activity, number>;
  daily(deviceId: string, maxDays?: number): DayTotal[];
}

export interface DayTotal {
  /** Өдрийн эхлэл (локал цагаар 00:00, ms) */
  day: number;
  durations: Record<Activity, number>;
}

const MAX_SAMPLES = 3000; // ~60 сек @ 50 Hz
const MAX_SEGMENTS = 20_000;
const DATA_FILE = path.join(process.cwd(), ".data", "history.json");
const SAVE_EVERY_MS = 10_000;
const CLOUD_MODE = Boolean(
  (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN),
);

interface SavedFile {
  version: 1;
  devices: Record<string, { device: DeviceStatus; segments: Segment[]; alerts: Alert[] }>;
}

export interface DeviceState {
  samples: SensorSample[];
  predictions: Prediction[];
  segments: Segment[];
  gps: GpsFix | null;
  alerts: Alert[];
}

export class MemoryRepository implements Repository {
  private devices = new Map<string, DeviceStatus>();
  private state = new Map<string, DeviceState>();
  private alertSeq = 0;
  private dirty = false;

  constructor() {
    // Үүлэн горимд (Vercel + Redis) төлөв Redis-д хадгалагдана → .data файлд бичихгүй
    if (CLOUD_MODE) return;
    this.load();
    const timer = setInterval(() => this.save(), SAVE_EVERY_MS);
    timer.unref?.();
  }

  private load() {
    let saved: SavedFile;
    try {
      saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as SavedFile;
    } catch {
      return;
    }
    for (const [id, d] of Object.entries(saved.devices ?? {})) {
      if (!d?.device) continue;
      this.devices.set(id, { ...d.device, online: false });
      const st = this.s(id);
      st.segments = Array.isArray(d.segments) ? d.segments : [];
      st.alerts = Array.isArray(d.alerts) ? d.alerts : [];
      for (const a of st.alerts) this.alertSeq = Math.max(this.alertSeq, Number(String(a.id).replace(/\D/g, "")) || 0);
    }
    console.log(`[store] түүх сэргээлээ: ${this.devices.size} төхөөрөмж (${DATA_FILE})`);
  }

  private save() {
    if (!this.dirty) return;
    this.dirty = false;
    const devices: SavedFile["devices"] = {};
    for (const [id, dev] of this.devices) {
      if (dev.simulated) continue;
      const st = this.state.get(id);
      devices[id] = { device: dev, segments: st?.segments ?? [], alerts: st?.alerts ?? [] };
    }
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices } satisfies SavedFile));
      fs.renameSync(tmp, DATA_FILE); // бичиж дуусахаас өмнө унтарсан ч хуучин файл эвдрэхгүй
    } catch (e) {
      console.error("[store] түүх хадгалж чадсангүй:", e);
    }
  }

  private touch(deviceId: string) {
    if (!this.devices.get(deviceId)?.simulated) this.dirty = true;
  }

  private s(id: string): DeviceState {
    let st = this.state.get(id);
    if (!st) {
      st = { samples: [], predictions: [], segments: [], gps: null, alerts: [] };
      this.state.set(id, st);
    }
    return st;
  }

  upsertDevice(d: Partial<DeviceStatus> & { deviceId: string }): DeviceStatus {
    const prev = this.devices.get(d.deviceId);
    const next: DeviceStatus = {
      name: d.deviceId,
      online: true,
      lastSeen: Date.now(),
      sampleRateHz: 50,
      simulated: false,
      ...prev,
      ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)),
    } as DeviceStatus;
    this.devices.set(d.deviceId, next);
    return next;
  }

  getDevice(id: string) {
    return this.devices.get(id);
  }

  listDevices() {
    return [...this.devices.values()];
  }

  addSamples(id: string, samples: SensorSample[]) {
    const st = this.s(id);
    st.samples.push(...samples);
    if (st.samples.length > MAX_SAMPLES) st.samples.splice(0, st.samples.length - MAX_SAMPLES);
  }

  getWindow(id: string, ms: number) {
    const st = this.s(id);
    if (!st.samples.length) return [];
    const end = st.samples[st.samples.length - 1].t;
    return st.samples.filter((x) => x.t > end - ms);
  }

  addPrediction(p: Prediction) {
    const st = this.s(p.deviceId);
    st.predictions.push(p);
    if (st.predictions.length > 600) st.predictions.shift();
    const last = st.segments[st.segments.length - 1];
    if (last && last.activity === p.activity && p.t - last.end < 5000) last.end = p.t;
    else st.segments.push({ activity: p.activity, start: last && p.t - last.end < 5000 ? last.end : p.t - 1000, end: p.t });
    if (st.segments.length > MAX_SEGMENTS) st.segments.shift();
    this.touch(p.deviceId);
  }

  /** Үүлэн (Vercel + Redis) горим: төхөөрөмжийн бүх төлөвийг гаргаж / ачаалах */
  exportDevice(id: string): { device: DeviceStatus | undefined; state: DeviceState; alertSeq: number } {
    return { device: this.devices.get(id), state: this.s(id), alertSeq: this.alertSeq };
  }
  importDevice(device: DeviceStatus, state: Partial<DeviceState>, alertSeq = 0) {
    this.devices.set(device.deviceId, device);
    this.state.set(device.deviceId, { samples: [], predictions: [], segments: [], gps: null, alerts: [], ...state });
    this.alertSeq = Math.max(this.alertSeq, alertSeq);
  }

  /** Simulator-ийн түүхэн өгөгдөл нөхөх зориулалттай */
  pushSegment(id: string, seg: Segment) {
    this.s(id).segments.push(seg);
  }

  latestPrediction(id: string) {
    const p = this.s(id).predictions;
    return p.length ? p[p.length - 1] : null;
  }

  segments(id: string, since: number) {
    return this.s(id).segments.filter((x) => x.end >= since);
  }

  setGps(id: string, fix: GpsFix) {
    this.s(id).gps = fix;
  }

  getGps(id: string) {
    return this.s(id).gps;
  }

  addAlert(a: Omit<Alert, "id" | "acknowledged">): Alert {
    const alert: Alert = { ...a, id: `al_${++this.alertSeq}`, acknowledged: false };
    const list = this.s(a.deviceId).alerts;
    list.unshift(alert);
    if (list.length > 100) list.pop();
    this.touch(a.deviceId);
    return alert;
  }

  alerts(id: string, limit = 20) {
    return this.s(id).alerts.slice(0, limit);
  }

  ackAlert(deviceId: string, id: string) {
    const a = this.state.get(deviceId)?.alerts.find((x) => x.id === id);
    if (!a) return false;
    a.acknowledged = true;
    this.touch(deviceId);
    return true;
  }

  durations(id: string, since: number, until: number) {
    const out = emptyDurations();
    for (const seg of this.s(id).segments) {
      const a = Math.max(seg.start, since);
      const b = Math.min(seg.end, until);
      if (b > a) out[seg.activity] += b - a;
    }
    return out;
  }

  daily(id: string, maxDays = 30, now = Date.now()) {
    const segs = this.state.get(id)?.segments ?? [];
    if (!segs.length) return [];
    const first = segs.reduce((m, x) => Math.min(m, x.start), Infinity);
    const out: DayTotal[] = [];
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    for (let k = 0; k < maxDays; k++) {
      const start = d.getTime();
      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      if (next.getTime() <= first) break;
      const durations = this.durations(id, start, Math.min(next.getTime(), now));
      if (Object.values(durations).some((v) => v > 0)) out.push({ day: start, durations });
      d.setDate(d.getDate() - 1);
    }
    return out;
  }
}

// Next.js dev горимд модуль дахин ачаалагдахад төлөв алдагдахгүйн тулд globalThis-д хадгална
const g = globalThis as unknown as { __repo?: MemoryRepository };
export function getRepository(): MemoryRepository {
  if (!g.__repo) g.__repo = new MemoryRepository();
  return g.__repo;
}
