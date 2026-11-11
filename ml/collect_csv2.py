"""
MotionCare — ESP32-ээс USB Serial-аар 50 Hz хэмжилт цуглуулж CSV болгон хадгална.

Firmware: firmware/motioncare_v2/motioncare_v2.ino  (SERIAL_DATA 1)
Arduino IDE-ийн Serial Monitor-ийг ХААСАН байх ёстой (эс бөгөөс "Access is denied").

Ажиллуулах (ml/ хавтаснаас):
    py collect_csv2.py                         # асуултаар
    py collect_csv2.py walking 120             # шууд
    py collect_csv2.py fall 8 --port COM16
    py collect_csv2.py --check data/*.csv      # бэлэн CSV-үүдийн чанарыг шалгах (ESP32 хэрэггүй)
    py collect_csv2.py --protocol              # дараалсан бичлэг (~3 мин): дуут дохиогоор
                                               # зогсох → алхах → суух → ... шилжилттэй

Хадгалах формат: t,ax,ay,az,gx,gy,gz,label   (t = бичлэг эхэлснээс хойшх мс, төхөөрөмжийн цагаар)
"""
import argparse
import csv
import glob
import math
import sys
import time
from datetime import datetime
from pathlib import Path

LABELS = ["sitting", "standing", "walking", "running", "lying", "fall"]
MN = {"sitting": "СУУ", "standing": "ЗОГС", "walking": "АЛХ", "running": "ГҮЙ", "lying": "ХЭВТ", "fall": "УН"}

# Дараалсан бичлэг: (хөдөлгөөн, секунд). Шилжилт бүр (алхаж байгаад суух гэх мэт) бодит амьдралд гардаг.
# 4-р алхмын суулт сандал дээр, 9–11-р алхам орон/буйдан дээр (суух → хэвтэх → суух).
PROTOCOL = [
    ("standing", 15), ("walking", 20), ("standing", 8), ("sitting", 20), ("standing", 10),
    ("walking", 15), ("running", 15), ("walking", 12), ("sitting", 15), ("lying", 20),
    ("sitting", 12), ("standing", 10), ("walking", 15),
]
GRACE_S = 2.5  # шинэ дохионы дараах энэ хугацаа "шилжилт" гэж тэмдэглэгдэнэ
HZ = 50
DT_MS = 1000 / HZ


def quality(rows, label=None):
    lines, problems = [], []
    if len(rows) < 2:
        return ["хэмжилт алга"], ["өгөгдөл хангалтгүй"]

    ts = [r[0] for r in rows]
    span_s = (ts[-1] - ts[0]) / 1000
    dts = [b - a for a, b in zip(ts, ts[1:])]
    hz = (len(rows) - 1) / span_s if span_s > 0 else float("inf")
    bad_order = sum(1 for d in dts if d <= 0)
    gaps = [d for d in dts if d > 1.5 * DT_MS]
    lost = sum(round(d / DT_MS) - 1 for d in gaps)
    dup_vals = sum(1 for a, b in zip(rows, rows[1:]) if a[1:] == b[1:])
    dts_sorted = sorted(dts)
    median_dt = dts_sorted[len(dts_sorted) // 2]

    lines.append(f"хэмжилт: {len(rows)}   хугацаа: {span_s:.1f} сек   давтамж: {hz:.1f} Hz")
    lines.append(f"интервал: дундаж {median_dt:.0f} мс, хамгийн их {max(dts):.0f} мс")
    lines.append(f"алдагдсан хэмжилт: {lost}   давхардсан утга: {dup_vals}   цаг буцсан/ижил: {bad_order}")

    if not 47 <= hz <= 53:
        problems.append(f"давтамж {hz:.0f} Hz (50 Hz байх ёстой)")
    if not 18 <= median_dt <= 22:
        problems.append(f"хэмжилт хоорондын дундаж зай {median_dt:.0f} мс (20 мс байх ёстой)")
    if bad_order:
        problems.append(f"{bad_order} мөрийн цаг өмнөхөөсөө хойш биш (давхар хэвлэлт)")
    if dup_vals > 0.01 * len(rows):
        problems.append(f"{dup_vals} мөр өмнөхтэйгөө яг ижил утгатай ({dup_vals / len(rows):.0%})")
    if lost > 0.01 * len(rows):
        problems.append(f"{lost} хэмжилт алдагдсан ({lost / (len(rows) + lost):.0%})")
    if max(dts) > 500:
        problems.append(f"{max(dts) / 1000:.1f} сек тасалдал байна")

    mags = [math.sqrt(r[1] ** 2 + r[2] ** 2 + r[3] ** 2) for r in rows]
    i = max(range(len(mags)), key=mags.__getitem__)
    peak_at = (ts[i] - ts[0]) / 1000
    lines.append(f"|a| хамгийн их: {mags[i]:.2f} g  ({peak_at:.1f} сек дээр)")
    if label == "fall":
        if mags[i] < 2.0:
            problems.append("2 g-ээс их цохилт алга — уналт бичигдээгүй байж магадгүй")
        else:
            if peak_at < 1.0:
                problems.append("уналтаас өмнөх хэсэг 1 сек-ээс богино")
            if span_s - peak_at < 2.0:
                problems.append("уналтын дараах хөдөлгөөнгүй хэсэг 2 сек-ээс богино")
    return lines, problems


def check_files(patterns):
    files = sorted({p for pat in patterns for p in glob.glob(pat)})
    if not files:
        raise SystemExit("Файл олдсонгүй")
    bad = 0
    for p in files:
        with open(p, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows, label = [], None
            for x in reader:
                try:
                    rows.append([float(x[k]) for k in ("t", "ax", "ay", "az", "gx", "gy", "gz")])
                    label = x.get("label") or label
                except (KeyError, TypeError, ValueError):
                    continue
        lines, problems = quality(rows, label)
        print(f"\n{Path(p).name}  [{label}]")
        for ln in lines:
            print("   " + ln)
        if problems:
            bad += 1
            for pr in problems:
                print("   ✗ " + pr)
        else:
            print("   ✓ хэвийн")
    print(f"\n{len(files)} файлаас {bad} нь асуудалтай.")


def parse(line):
    if not line.startswith("DATA,"):
        return None
    v = line.split(",")
    if len(v) != 8:
        return None
    try:
        row = [float(x) for x in v[1:]]
    except ValueError:
        return None
    return row if all(math.isfinite(x) for x in row) else None


def read_row(ser):
    return parse(ser.readline().decode("utf-8", errors="ignore").strip())


def drain(ser, seconds):
    n, end = 0, time.monotonic() + seconds
    while time.monotonic() < end:
        if read_row(ser):
            n += 1
    return n


def beep(long=False):
    try:
        import winsound  # зөвхөн Windows
        winsound.Beep(1300 if long else 900, 350 if long else 120)
    except Exception:
        print("\a", end="", flush=True)


def open_serial(port, baud):
    try:
        import serial
    except ImportError:
        raise SystemExit("pyserial алга:  py -m pip install pyserial")
    try:
        ser = serial.Serial(port, baud, timeout=0.2)
    except serial.SerialException as e:
        raise SystemExit(
            f"{port} нээгдсэнгүй: {e}\n"
            "→ Arduino Serial Monitor эсвэл өөр програм портыг эзэлсэн бол хаагаад дахин оролдоно уу.\n"
            "→ Порт өөр бол:  --port COMxx"
        )
    ser.reset_input_buffer()
    if drain(ser, 0.7) == 0:
        ser.close()
        raise SystemExit(
            "ESP32-ээс DATA мөр ирсэнгүй.\n"
            "→ motioncare_v2 firmware ачаалсан, SERIAL_DATA 1 эсэхийг шалгана уу.\n"
            "→ Arduino: Tools → USB CDC On Boot → Enabled"
        )
    return ser


def record_protocol(port, baud, steps, countdown):
    total = sum(sec for _, sec in steps)
    print(f"Дараалсан бичлэг: {len(steps)} алхам, {total / 60:.1f} мин. Сандал, орон/буйдан ойрхон байх хэрэгтэй.")
    for k, (lab, sec) in enumerate(steps, 1):
        print(f"  {k:2d}. {MN[lab]:5s} {sec:3d} сек")
    print("Дохио: богино 'пип' = 3 сек-ийн дараа солигдоно, урт 'пиип' = одоо шилж.")
    input("Бэлэн бол Enter дарна уу...")
    bounds, acc = [], 0.0
    for lab, sec in steps:
        bounds.append((acc, acc + sec, lab))
        acc += sec
    ser = open_serial(port, baud)
    with ser:
        for k in range(countdown, 0, -1):
            print(f"  {k}...", flush=True)
            drain(ser, 1.0)
        rows, last_t, t0, step, warned = [], None, None, -1, set()
        start = time.monotonic()
        while time.monotonic() - start < total:
            el = time.monotonic() - start
            cur = next((i for i, (a, b, _) in enumerate(bounds) if a <= el < b), len(bounds) - 1)
            if cur != step:
                step = cur
                beep(long=True)
                print(f"\n▶ {step + 1}/{len(steps)}  {MN[bounds[step][2]]}  ({steps[step][1]} сек)", flush=True)
            if step + 1 < len(bounds) and bounds[step][1] - el <= 3 and step not in warned:
                warned.add(step)
                beep()
                print(f"   … дараа нь {MN[bounds[step + 1][2]]}", flush=True)
            r = read_row(ser)
            if r is None or (last_t is not None and r[0] <= last_t):
                continue
            last_t = r[0]
            t0 = r[0] if t0 is None else t0
            dev_el = (r[0] - t0) / 1000  # төхөөрөмжийн цагаар → дохионы саатал шошгонд нөлөөлөхгүй
            i = next((i for i, (a, b, _) in enumerate(bounds) if a <= dev_el < b), len(bounds) - 1)
            a0, _, lab = bounds[i]
            rows.append((r, lab, int(i > 0 and dev_el - a0 < GRACE_S)))
    beep(long=True)
    print("\n■ Дууслаа.")
    return rows


def save_protocol(rows):
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    out = data_dir / f"protocol_{datetime.now():%Y%m%d_%H%M%S}.csv"
    t0 = rows[0][0][0]
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["t", "ax", "ay", "az", "gx", "gy", "gz", "label", "transition"])
        for r, lab, tr in rows:
            w.writerow([int(r[0] - t0)] + r[1:] + [lab, tr])
    return out


def record(port, baud, label, seconds, countdown):

    ser = open_serial(port, baud)
    with ser:
        if label == "fall":
            print("Уналт: GO гарсны дараа 2–3 сек зогсоод, ЗӨӨЛӨН дэвсгэр/матрас руу унаж, 3–4 сек хөдөлгөөнгүй хэвтэнэ.")
        for k in range(countdown, 0, -1):
            print(f"  {k}...", flush=True)
            drain(ser, 1.0)  # тоолж байх хооронд ч уншина → буфер хуримтлагдахгүй

        print(f"▶ GO!  {label} — {seconds:g} сек бичиж байна...", flush=True)
        rows, last_t = [], None
        start = time.monotonic()
        while time.monotonic() - start < seconds:
            r = read_row(ser)
            if r is None:
                continue
            if last_t is not None and r[0] <= last_t:
                continue  # цаг нь урагшлаагүй мөр = давхардал
            last_t = r[0]
            rows.append(r)
    print("■ Дууслаа.")
    return rows


def save(rows, label):
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    out = data_dir / f"{label}_{datetime.now():%Y%m%d_%H%M%S}.csv"
    t0 = rows[0][0]
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["t", "ax", "ay", "az", "gx", "gy", "gz", "label"])
        for r in rows:
            w.writerow([int(r[0] - t0)] + r[1:] + [label])
    return out


def main():
    ap = argparse.ArgumentParser(description="ESP32 → CSV (50 Hz) цуглуулагч")
    ap.add_argument("label", nargs="?", help="|".join(LABELS))
    ap.add_argument("seconds", nargs="?", type=float, help="бичих хугацаа (сек)")
    ap.add_argument("--port", default="COM16")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--countdown", type=int, default=3, help="эхлэхээс өмнөх тоолол (сек)")
    ap.add_argument("--check", nargs="+", metavar="CSV", help="бэлэн CSV файлуудыг шалгах")
    ap.add_argument("--protocol", action="store_true", help="дуут дохиотой дараалсан бичлэг (шилжилттэй)")
    a = ap.parse_args()

    if a.check:
        check_files(a.check)
        return

    if a.protocol:
        rows = record_protocol(a.port, a.baud, PROTOCOL, a.countdown)
        lines, problems = quality([r for r, _, _ in rows])
        for ln in lines:
            print("   " + ln)
        for pr in problems:
            print("   ✗ " + pr)
        if problems and input("Асуудалтай байна. Хадгалах уу? [y/N]: ").strip().lower() != "y":
            print("Хадгалсангүй.")
            return
        if len(rows) >= 2:
            print(f"Хадгалагдлаа: {save_protocol(rows)}")
        return

    label = (a.label or input(f"Movement label ({', '.join(LABELS)}): ")).strip().lower()
    if label not in LABELS:
        raise SystemExit(f"Буруу шошго: {label!r}. Боломжтой: {', '.join(LABELS)}")
    seconds = a.seconds or float(input("Recording duration in seconds: "))
    if label == "fall" and seconds < 7:
        print(f"⚠ Уналтад {seconds:g} сек богино — 8–10 сек зөвлөж байна (өмнө нь зогсох + дараа нь хэвтэх хэсэг хэрэгтэй).")

    rows = record(a.port, a.baud, label, seconds, a.countdown)
    lines, problems = quality(rows, label)
    for ln in lines:
        print("   " + ln)
    if problems:
        for pr in problems:
            print("   ✗ " + pr)
        if input("Асуудалтай байна. Хадгалах уу? [y/N]: ").strip().lower() != "y":
            print("Хадгалсангүй.")
            return
    else:
        print("   ✓ Өгөгдөл хэвийн")
    if len(rows) < 2:
        return
    out = save(rows, label)
    print(f"Хадгалагдлаа: {out}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nЦуцлагдлаа")
