import type { Activity, Prediction, SensorSample } from "../types";

export interface Classifier {
  readonly name: string;
  predict(deviceId: string, window: SensorSample[]): Promise<Prediction | null>;
}

const ALL: Activity[] = ["sitting", "standing", "walking", "running", "lying", "fall"];

function stats(xs: number[]) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(v), max: Math.max(...xs) };
}

function softmax(raw: Record<Activity, number>): Record<Activity, number> {
  const exps = ALL.map((k) => Math.exp(raw[k]));
  const sum = exps.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ALL.map((k, i) => [k, exps[i] / sum])) as Record<Activity, number>;
}

/**
 * Baseline: шинж чанарт (feature) суурилсан энгийн ангилагч.
 * Мэдрэгчийг бүсэлхийд зүүсэн, Y тэнхлэг босоо чиглэлтэй гэж үзнэ.
 * Сургасан ML загвар бэлэн болохоор RemoteClassifier-ээр солигдоно.
 */
export class HeuristicClassifier implements Classifier {
  readonly name = "baseline-heuristic-v1";

  async predict(deviceId: string, w: SensorSample[]): Promise<Prediction | null> {
    if (w.length < 20) return null;
    const started = performance.now();
    const mag = w.map((s) => Math.hypot(s.ax, s.ay, s.az));
    const m = stats(mag);
    const ay = stats(w.map((s) => s.ay)).mean;
    const tail = mag.slice(-Math.floor(mag.length / 3));
    const tailStd = stats(tail).std;

    const raw: Record<Activity, number> = { sitting: 0, standing: 0, walking: 0, running: 0, lying: 0, fall: 0 };
    raw.running = (m.std - 0.5) * 12;
    raw.walking = 3 - Math.abs(m.std - 0.3) * 14;
    const still = Math.max(0, 1 - m.std * 8);
    const moving = (1 - still) * 6;
    raw.standing = still * (5 - Math.abs(ay - 0.98) * 18) - moving;
    raw.sitting = still * (5 - Math.abs(ay - 0.72) * 14) - moving;
    raw.lying = still * (5 - Math.abs(ay - 0.08) * 10) - moving;
    // Уналт: огцом цохилт (>2.6 g) араас нь хөдөлгөөнгүй, хэвтээ байрлал
    raw.fall = m.max > 2.6 && tailStd < 0.12 && ay < 0.45 ? 9 : -6;

    const scores = softmax(raw);
    const activity = ALL.reduce((best, k) => (scores[k] > scores[best] ? k : best), ALL[0]);
    return {
      deviceId,
      t: w[w.length - 1].t,
      activity,
      confidence: scores[activity],
      scores,
      model: this.name,
      latencyMs: performance.now() - started,
    };
  }
}

/**
 * Гадаад ML үйлчилгээ (ml/ хавтас дахь Python сервер) рүү хандах ангилагч.
 * Хариу: { activity, scores, model }
 */
export class RemoteClassifier implements Classifier {
  readonly name = "remote-ml";
  constructor(private url: string, private fallback: Classifier) {}

  async predict(deviceId: string, w: SensorSample[]): Promise<Prediction | null> {
    const started = performance.now();
    try {
      const res = await fetch(`${this.url.replace(/\/$/, "")}/predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, samples: w }),
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) throw new Error(`ML service ${res.status}`);
      const j = (await res.json()) as { activity: Activity; scores: Record<Activity, number>; model?: string; transition?: number };
      return {
        deviceId,
        t: w[w.length - 1].t,
        activity: j.activity,
        confidence: j.scores[j.activity] ?? 0,
        scores: j.scores,
        model: j.model ?? this.name,
        latencyMs: performance.now() - started,
        transition: j.transition,
      };
    } catch {
      return this.fallback.predict(deviceId, w);
    }
  }
}

export function createClassifier(): Classifier {
  const base = new HeuristicClassifier();
  const url = process.env.ML_SERVICE_URL;
  return url ? new RemoteClassifier(url, base) : base;
}
