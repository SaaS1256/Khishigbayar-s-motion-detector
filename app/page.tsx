"use client";

import { useLive } from "@/components/LiveProvider";
import { AlertsCard, CurrentActivityCard, ScoresCard } from "@/components/dashboard";
import { LiveSensorCard } from "@/components/LiveSensorCard";
import { PageTitle, Skeleton } from "@/components/ui";

const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];
function today() {
  const d = new Date();
  return `${d.getMonth() + 1}-р сарын ${d.getDate()}, ${WEEKDAYS[d.getDay()]} гараг`;
}

export default function SummaryPage() {
  const { snap } = useLive();

  return (
    <>
      <PageTitle title="Өндөр настныг хянах систем" subtitle={today()} />
      {!snap ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-60 rounded-[20px]" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <CurrentActivityCard snap={snap} />
            <LiveSensorCard />
          </div>
          <div className="space-y-4">
            <AlertsCard snap={snap} />
            <ScoresCard snap={snap} />
          </div>
        </div>
      )}
    </>
  );
}
