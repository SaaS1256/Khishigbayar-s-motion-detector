export type Activity = "sitting" | "standing" | "walking" | "running" | "lying" | "fall";

/** MPU6050-ийн нэг хэмжилт. Хурдатгал g-ээр, эргэлт °/s-ээр */
export interface SensorSample {
  /** Unix хугацаа (ms) */
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}

export interface GpsFix {
  lat: number;
  lng: number;
  /** Нарийвчлал (метр) */
  accuracy?: number;
  t: number;
}

export interface IngestPayload {
  deviceId: string;
  samples: SensorSample[];
  gps?: Omit<GpsFix, "t"> & { t?: number };
  battery?: number; // 0–100
  rssi?: number; // dBm
  ip?: string;
}

export interface Prediction {
  deviceId: string;
  t: number;
  activity: Activity;
  confidence: number; // 0–1
  scores: Record<Activity, number>;
  model: string;
  latencyMs: number;
  /** ML-ийн "шилжилт" (суух/босох/хэвтэх хөдөлгөөн) магадлал 0–1. 0.5-аас их бол ангиллыг солихгүй */
  transition?: number;
}

export interface Segment {
  activity: Activity;
  start: number;
  end: number;
}

export interface Alert {
  id: string;
  deviceId: string;
  t: number;
  kind: "fall" | "inactivity" | "offline";
  message: string;
  gps?: GpsFix;
  acknowledged: boolean;
}

export interface DeviceStatus {
  deviceId: string;
  name: string;
  online: boolean;
  lastSeen: number;
  battery?: number;
  rssi?: number;
  sampleRateHz: number;
  simulated: boolean;
  ip?: string;
}

export interface Snapshot {
  now: number;
  device: DeviceStatus | null;
  current: Prediction | null;
  currentSince: number | null;
  signal: { t: number; mag: number; ax: number; ay: number; az: number }[];
  /** Өнөөдрийн ангилал тус бүрийн хугацаа (ms) */
  today: Record<Activity, number>;
  timeline: Segment[];
  alerts: Alert[];
  gps: GpsFix | null;
}

export interface DeviceResponse {
  ok: true;
  activity: Activity | null;
  label: string | null;
  confidence: number | null;
  alert: boolean;
}
