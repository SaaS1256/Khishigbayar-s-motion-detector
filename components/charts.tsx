"use client";

import { ACTIVITIES, ACTIVITY_ORDER } from "@/lib/activities";
import { fmtDuration } from "@/lib/format";
import type { Activity, Snapshot } from "@/lib/types";

export function SignalChart({ data, now, color = "#2a61fd" }: { data: Snapshot["signal"]; now: number; color?: string }) {
  const W = 600;
  const H = 160;
  const span = 10_000;
  const yMax = Math.max(2, ...data.map((d) => d.mag)) * 1.1;
  const x = (t: number) => ((t - (now - span)) / span) * W;
  const y = (v: number) => H - (v / yMax) * H;
  const line = (k: "mag" | "ax" | "ay" | "az") =>
    data.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(Math.abs(d[k])).toFixed(1)}`).join("");
  const area = data.length ? `${line("mag")}L${x(data[data.length - 1].t)},${H}L${x(data[0].t)},${H}Z` : "";

  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-44 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sig" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((g) => (
        <line key={g} x1={0} x2={W} y1={y((yMax / 3) * g)} y2={y((yMax / 3) * g)} stroke="var(--sep)" strokeDasharray={g ? "3 4" : undefined} />
      ))}
      <path d={area} fill="url(#sig)" />
      <path d={line("ay")} fill="none" stroke="#9e9e9e" strokeOpacity="0.6" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <path d={line("az")} fill="none" stroke="#151515" strokeOpacity="0.45" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <path d={line("mag")} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {[10, 5, 0].map((s) => (
        <text key={s} x={x(now - s * 1000)} y={H + 14} fontSize="11" fill="var(--muted)" textAnchor={s === 10 ? "start" : s === 0 ? "end" : "middle"}>
          {s === 0 ? "одоо" : `-${s}с`}
        </text>
      ))}
    </svg>
  );
}

export function ActivityRings({ rings }: { rings: { value: number; goal: number; color: string }[] }) {
  const size = 132;
  const stroke = 14;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      {rings.map((r, i) => {
        const rad = size / 2 - stroke / 2 - i * (stroke + 3);
        const c = 2 * Math.PI * rad;
        const p = Math.min(r.value / r.goal, 1);
        return (
          <g key={i}>
            <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={r.color} strokeOpacity="0.18" strokeWidth={stroke} />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={rad}
              fill="none"
              stroke={r.color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${c * p} ${c}`}
              style={{ transition: "stroke-dasharray .6s ease" }}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function DayBar({ today }: { today: Record<Activity, number> }) {
  const keys = ACTIVITY_ORDER.filter((k) => k !== "fall");
  const total = keys.reduce((s, k) => s + today[k], 0) || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-fill">
        {keys.map((k) => (
          <div key={k} style={{ width: `${(today[k] / total) * 100}%`, background: ACTIVITIES[k].color }} className="transition-all duration-700" />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2.5">
        {keys.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ACTIVITIES[k].color }} />
            <span className="whitespace-nowrap text-[13px] text-muted">{ACTIVITIES[k].noun}</span>
            <span className="tabular ml-auto whitespace-nowrap text-[13px] font-semibold">{fmtDuration(today[k])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HourlyChart({ hours }: { hours: { hour: number; durations: Record<Activity, number> | null }[] }) {
  const W = 720;
  const H = 200;
  const bw = W / 24;
  const keys = ACTIVITY_ORDER.filter((k) => k !== "fall");
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="h-60 w-full">
      {[0, 30, 60].map((m) => (
        <g key={m}>
          <line x1={0} x2={W} y1={H - (m / 60) * H} y2={H - (m / 60) * H} stroke="var(--sep)" strokeDasharray={m ? "3 4" : undefined} />
          {m > 0 && (
            <text x={W} y={H - (m / 60) * H - 4} fontSize="10" fill="var(--muted)" textAnchor="end">
              {m} мин
            </text>
          )}
        </g>
      ))}
      {hours.map(({ hour, durations }) => {
        if (!durations) return null;
        let acc = 0;
        return (
          <g key={hour}>
            {keys.map((k) => {
              const h = (durations[k] / 3_600_000) * H;
              acc += h;
              return h > 0.2 ? <rect key={k} x={hour * bw + 3} y={H - acc} width={bw - 6} height={h} fill={ACTIVITIES[k].color} rx={2} /> : null;
            })}
          </g>
        );
      })}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={h * bw + 3} y={H + 16} fontSize="11" fill="var(--muted)">
          {String(h).padStart(2, "0")}:00
        </text>
      ))}
    </svg>
  );
}
