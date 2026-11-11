"use client";

import { useEffect, useState } from "react";
import { HourlyChart } from "@/components/charts";
import { ActivityIcon, Clock, Rings } from "@/components/Icons";
import { Card, CardHeader, PageTitle, Skeleton } from "@/components/ui";
import { ACTIVITIES, ACTIVITY_ORDER, emptyDurations } from "@/lib/activities";
import { fmtClock, fmtDuration } from "@/lib/format";
import type { Activity, Segment } from "@/lib/types";

interface History {
  hours: { hour: number; durations: Record<Activity, number> | null }[];
  segments: Segment[];
  days?: { day: number; durations: Record<Activity, number> }[];
}

const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];
const MIN_MS = 10_000;
const JOIN_GAP_MS = 120_000;

/**
 * Бүртгэлийн мөрүүдийг цэгцлэнэ: богино тасалдлыг алгасаж, дараалсан ижил үйлдлийг нэг мөр болгоно.
 * Жишээ: "Суух 1 мин", "Зогсох 3 сек", "Суух 1 мин" → "Суух 2 мин". Уналтыг хэзээ ч алгасахгүй.
 */
function mergeForLog(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.activity !== "fall" && s.end - s.start < MIN_MS) continue;
    const last = out[out.length - 1];
    if (last && last.activity === s.activity && s.start - last.end < JOIN_GAP_MS) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

const fmtLen = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} сек` : fmtDuration(ms));
const fmtMin = (ms: number) => (ms <= 0 ? "—" : ms < 60_000 ? "<1" : String(Math.round(ms / 60_000)));
function fmtDay(t: number, today: number) {
  if (t === today) return "Өнөөдөр";
  if (t === today - 86_400_000) return "Өчигдөр";
  const d = new Date(t);
  return `${d.getMonth() + 1}-р сарын ${d.getDate()}, ${WEEKDAYS[d.getDay()]}`;
}

export default function HistoryPage() {
  const [data, setData] = useState<History | null>(null);
  const [filter, setFilter] = useState<Activity | "all">("all");

  useEffect(() => {
    const load = () => fetch("/api/history", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  const totals = emptyDurations();
  data?.hours.forEach((h) => h.durations && ACTIVITY_ORDER.forEach((k) => (totals[k] += h.durations![k])));
  const segs = mergeForLog(data?.segments ?? [])
    .filter((s) => filter === "all" || s.activity === filter)
    .reverse();
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  return (
    <>
      <PageTitle title="Түүх" subtitle="Өнөөдөр" />
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {ACTIVITY_ORDER.filter((k) => k !== "fall").map((k) => (
          <button
            key={k}
            onClick={() => setFilter(filter === k ? "all" : k)}
            className={`card p-4 text-left transition ${filter === k ? "ring-2" : "hover:opacity-90"}`}
            style={{ ["--tw-ring-color" as string]: "#2a61fd" }}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "#141414" }}>
              <ActivityIcon activity={k} size={16} /> {ACTIVITIES[k].noun}
            </span>
            <p className="tabular mt-2 text-[22px] font-semibold">{data ? fmtDuration(totals[k]) : "—"}</p>
          </button>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader icon={<Rings size={18} />} title="Цаг тутмын хуваарилалт" color="#141414" meta="24 цаг" />
        {data ? <HourlyChart hours={data.hours} /> : <Skeleton className="h-60" />}
      </Card>

      <Card className="mt-4">
        <CardHeader icon={<Clock size={18} />} title="Өдөр тутмын нийлбэр" color="#141414" meta="минутаар" />
        {!data ? (
          <Skeleton className="h-32" />
        ) : !data.days?.length ? (
          <p className="py-6 text-center text-[13px] text-muted">Түүх алга</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[560px] text-[14px]">
              <thead>
                <tr className="text-[12px] text-muted">
                  <th className="pb-2 text-left font-normal">Өдөр</th>
                  {ACTIVITY_ORDER.map((k) => (
                    <th key={k} className="pb-2 text-right font-normal">
                      <span className="inline-flex items-center gap-1.5">
                        <i className="h-2.5 w-2.5 rounded-sm" style={{ background: ACTIVITIES[k].color }} />
                        {ACTIVITIES[k].noun}
                      </span>
                    </th>
                  ))}
                  <th className="pb-2 text-right font-normal">Нийт</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sep border-t border-sep">
                {data.days.map((d) => {
                  const total = ACTIVITY_ORDER.reduce((a, k) => a + d.durations[k], 0);
                  return (
                    <tr key={d.day}>
                      <td className="py-2.5 font-medium">{fmtDay(d.day, today0.getTime())}</td>
                      {ACTIVITY_ORDER.map((k) => (
                        <td
                          key={k}
                          className={`py-2.5 text-right ${d.durations[k] > 0 ? "" : "text-muted"}`}
                          style={k === "fall" && d.durations[k] > 0 ? { color: ACTIVITIES.fall.color } : undefined}
                        >
                          {fmtMin(d.durations[k])}
                        </td>
                      ))}
                      <td className="py-2.5 text-right font-semibold">{fmtMin(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader
          icon={<Clock size={18} />}
          title="Бүртгэл"
          color="#141414"
          meta={filter === "all" ? `${segs.length} үйлдэл` : ACTIVITIES[filter].short}
        />
        <ul className="divide-y divide-sep">
          {segs.slice(0, 80).map((s, i) => {
            const m = ACTIVITIES[s.activity];
            return (
              <li key={`${s.start}-${i}`} className="flex items-center gap-3 py-3">
                <span className="grid h-9 w-9 place-items-center rounded-[11px]" style={{ background: m.soft, color: s.activity === "fall" ? m.color : "#141414" }}>
                  <ActivityIcon activity={s.activity} size={20} />
                </span>
                <div>
                  <p className="text-[15px] font-medium">{m.noun}</p>
                  <p className="tabular text-[12px] text-muted">{fmtClock(s.start)} – {fmtClock(s.end)}</p>
                </div>
                <span className="tabular ml-auto text-[14px] text-muted">{fmtLen(s.end - s.start)}</span>
              </li>
            );
          })}
          {data && !segs.length && <li className="py-8 text-center text-[13px] text-muted">Бүртгэл алга</li>}
        </ul>
      </Card>
    </>
  );
}
