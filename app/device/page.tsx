"use client";

import { Brain, Chip, Pulse } from "@/components/Icons";
import { useLive } from "@/components/LiveProvider";
import { DeviceCard } from "@/components/dashboard";
import { Card, CardHeader, PageTitle } from "@/components/ui";
import { ACTIVITIES } from "@/lib/activities";


const SAMPLE = `curl -X POST http://localhost:3000/api/ingest \\
  -H "content-type: application/json" \\
  -H "x-device-key: dev-secret-key" \\
  -d '{
    "deviceId": "esp32-01",
    "battery": 92, "rssi": -60,
    "gps": { "lat": 47.9184, "lng": 106.9177, "accuracy": 2.5 },
    "samples": [
      { "t": 1730000000000, "ax": 0.05, "ay": 0.99, "az": 0.08, "gx": 0.4, "gy": -0.2, "gz": 0.1 }
    ]
  }'`;

const RESPONSE = `{ "ok": true, "activity": "walking", "label": "Алхах", "confidence": 0.94, "alert": false }`;

export default function DevicePage() {
  const { snap } = useLive();
  const p = snap?.current;

  return (
    <>
      <PageTitle title="Төхөөрөмж" subtitle="ESP32-S3 · MPU6050" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          {snap && <DeviceCard snap={snap} />}
          <Card>
            <CardHeader icon={<Chip size={18} />} title="OLED дэлгэц" color="#1c1c1e" meta="серверийн хариу" />
            <div className="rounded-2xl bg-[#1c1c1e] p-2">
              <div className="grid h-36 place-items-center rounded-xl bg-black font-mono text-center">
                {p?.activity === "fall" ? (
                  <div className="text-[#ff6b61]">
                    <p className="text-lg font-bold">АНХААР!</p>
                    <p className="text-xs">УНАЛТ ИЛЭРЛЭЭ</p>
                  </div>
                ) : (
                  <div className="text-white">
                    <p className="text-[10px] tracking-widest text-[#8fd3ff]">ХӨДӨЛГӨӨН</p>
                    <p className="text-2xl font-bold">{p ? ACTIVITIES[p.activity].short : "---"}</p>
                    <p className="text-xs">Магадлал: {p ? Math.round(p.confidence * 100) : 0}%</p>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
 
      </div>
    </>
  );
}
