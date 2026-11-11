// ESP32-C3 төхөөрөмжийг дуурайж /api/ingest руу өгөгдөл илгээх тест скрипт.
// Ажиллуулах:  node scripts/fake-device.mjs [http://localhost:3000] [dev-secret-key]
import { createServer } from "node:http";
import { createHash } from "node:crypto";
const SERVER = process.argv[2] ?? "http://localhost:3000";
const KEY = process.argv[3] ?? "dev-secret-key";
const HZ = 50, BATCH_MS = 100, WS_PORT = Number(process.env.WS_PORT ?? 81);
const PLAN = [["standing", 10], ["walking", 15], ["running", 10], ["sitting", 15], ["lying", 10]];
const boot = Date.now();
const millis = () => Date.now() - boot;
const n = (s) => (Math.random() * 2 - 1) * s;

function sample(act, t) {
  const w = 2 * Math.PI * (t / 1000);
  switch (act) {
    case "walking": return { ax: 0.15 * Math.sin(w * 1.9) + n(0.05), ay: 0.98 + 0.42 * Math.sin(w * 3.8) + n(0.08), az: 0.12 + n(0.05), gx: 25 * Math.sin(w * 1.9), gy: n(8), gz: n(4) };
    case "running": return { ax: 0.35 * Math.sin(w * 2.8) + n(0.15), ay: 1.0 + 1.25 * Math.sin(w * 5.6) + n(0.2), az: 0.2 + n(0.12), gx: 70 * Math.sin(w * 2.8), gy: n(20), gz: n(10) };
    case "sitting": return { ax: 0.08 + n(0.02), ay: 0.72 + n(0.02), az: 0.66 + n(0.02), gx: n(1), gy: n(1), gz: n(1) };
    case "lying": return { ax: 0.1 + n(0.02), ay: 0.06 + n(0.02), az: 0.99 + n(0.02), gx: n(1), gy: n(1), gz: n(1) };
    default: return { ax: 0.05 + n(0.02), ay: 0.99 + n(0.02), az: 0.08 + n(0.02), gx: n(1.5), gy: n(1.5), gz: n(1.5) };
  }
}

const sockets = new Set();
const wsSrv = createServer((_, res) => res.writeHead(426).end());
wsSrv.on("upgrade", (req, sock) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  sockets.add(sock);
  sock.on("data", (b) => { if ((b[0] & 0x0f) === 8) sock.destroy(); });
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => sockets.delete(sock));
});
wsSrv.on("error", (e) => console.log(`WebSocket сервер нээгдсэнгүй (${e.message}) — зөвхөн HTTP ingest`));
wsSrv.listen(WS_PORT, () => console.log(`веб шууд: ws://127.0.0.1:${WS_PORT}`));
function wsSend(text) {
  const p = Buffer.from(text);
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  for (const s of sockets) s.write(Buffer.concat([h, p]));
}

const pending = [];
let lastGen = millis();
setInterval(() => {
  const act = PLAN[idx][0];
  const now = millis(), fresh = [];
  for (let t = lastGen + 1000 / HZ; t <= now; t += 1000 / HZ) {
    const s = sample(act, t);
    fresh.push({ t: Math.round(t), ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(3)])) });
    lastGen = t;
  }
  if (fresh.length) { pending.push(...fresh); wsSend(JSON.stringify(fresh)); }
}, 1000 / HZ);

let idx = 0, left = PLAN[0][1] * 1000;
setInterval(async () => {
  const act = PLAN[idx][0];
  const samples = pending.splice(0, pending.length);
  if (!samples.length) return;
  left -= BATCH_MS;
  if (left <= 0) { idx = (idx + 1) % PLAN.length; left = PLAN[idx][1] * 1000; }
  try {
    const r = await fetch(`${SERVER}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-key": KEY },
      body: JSON.stringify({ deviceId: "esp32c3-test", rssi: -55, ip: "127.0.0.1", samples }),
    });
    const j = await r.json();
    process.stdout.write(`\r[${act.padEnd(8)}] → ${r.status} ${j.label ?? j.error ?? ""} ${j.confidence ?? ""}      `);
  } catch (e) {
    process.stdout.write(`\rсервертэй холбогдож чадсангүй: ${e.message}      `);
  }
}, BATCH_MS);
