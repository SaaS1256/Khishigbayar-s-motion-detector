import argparse
from collections import Counter, defaultdict
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix

from features import extract_features

HERE = Path(__file__).parent
CLASSES = ["sitting", "standing", "walking", "running", "lying", "fall"]
COLS = ["ax", "ay", "az", "gx", "gy", "gz"]


def load(path):
    df = pd.read_csv(path)
    return df[COLS].to_numpy(np.float32), str(df["label"].iloc[0]), df


def is_protocol(df):
    return "transition" in df.columns or df["label"].nunique() > 1


def protocol_windows(x, y, tr, size, step):
    out = []
    for i in range(0, len(x) - size + 1, step):
        if tr[i : i + size].any():
            lab = "transition"
        else:
            v, c = np.unique(y[i : i + size], return_counts=True)
            lab = str(v[c.argmax()])
        out.append((x[i : i + size], lab))
    return out


# lib/server/pipeline.ts-ийн тогтворжуулалттай ижил (уналтын баталгаажуулалтгүй хувилбар)
HOLD_MS = {"running": 1000, "walking": 600, "sitting": 500, "standing": 500, "lying": 500, "fall": 0}


def stabilize_seq(preds, dt_ms=100):
    out, stable, cand, since = [], None, None, 0
    for i, r in enumerate(preds):
        t = i * dt_ms
        if r == "transition":
            pass
        elif stable is None:
            stable = r
        elif r == stable:
            cand = None
        else:
            if r != cand:
                cand, since = r, t
            if t - since >= HOLD_MS.get(r, 500):
                stable, cand = r, None
        out.append(stable or r)
    return out


def timeline_eval(model, name, x, y, tr, a):
    starts = list(range(0, len(x) - a.window + 1, 5))
    raw = list(model.predict(np.array([extract_features(x[i : i + a.window]) for i in starts])))
    filled, last = [], None
    for r in raw:
        last = last if r == "transition" else r
        filled.append(last or r)
    stab = stabilize_seq(raw)
    ends = [i + a.window - 1 for i in starts]
    keep = [k for k, e in enumerate(ends) if not tr[max(0, e - a.window + 1) : e + 1].any()]
    gt = [str(y[ends[k]]) for k in keep]
    acc_raw = np.mean([filled[k] == g for k, g in zip(keep, gt)])
    acc_stab = np.mean([stab[k] == g for k, g in zip(keep, gt)])
    fake_run = sum(1 for k in keep if stab[k] == "running" and str(y[ends[k]]) != "running")
    falls = sum(1 for r in raw if r == "fall")
    switches = sum(1 for p, q in zip(stab, stab[1:]) if p != q)
    real = sum(1 for p, q in zip(y[:-1], y[1:]) if p != q)
    print(f"  {name}: түүхий {acc_raw:.1%}, тогтворжуулсан {acc_stab:.1%} (шилжилтээс бусад хэсэг)")
    print(f"     ангилал солигдсон {switches} удаа (бодит {real}), худал 'гүйх' {fake_run * 0.1:.1f} сек, худал уналт {falls}")


def regular_windows(x, size, step):
    return [x[i : i + size] for i in range(0, len(x) - size + 1, step)]


def fall_windows(x, size, step, min_peak):

    mag = np.linalg.norm(x[:, :3], axis=1)
    p = int(mag.argmax())
    if mag[p] < min_peak:
        return [], float(mag[p])
    lo = max(0, p - int(size * 0.75))
    hi = min(len(x) - size, p - int(size * 0.25))
    return [x[i : i + size] for i in range(lo, hi + 1, step)], float(mag[p])


def feats(ws):
    return [extract_features(w) for w in ws]


def build(files, a):
    by_label = defaultdict(list)
    protocol = []
    for f in files:
        x, label, df = load(f)
        if is_protocol(df):
            tr = df["transition"].to_numpy(bool) if "transition" in df.columns else np.zeros(len(df), bool)
            protocol.append((f, x, df["label"].astype(str).to_numpy(), tr))
            continue
        if label not in CLASSES:
            print(f"  ! {f.name}: үл мэдэгдэх шошго {label!r} — алгаслаа")
            continue
        by_label[label].append((f, x))

    Xtr, ytr, Xte, yte, test_parts = [], [], [], [], []
    print("\nӨгөгдөл:")
    for label in CLASSES:
        items = by_label.get(label, [])
        if not items:
            print(f"  {label:9s} — файл алга!")
            continue
        test_idx = {k for k in range(len(items)) if k % 4 == 3} if len(items) >= 3 else set()
        if len(items) >= 3 and not test_idx:
            test_idx = {len(items) - 1}
        ntr = nte = 0
        for k, (f, x) in enumerate(items):
            if label == "fall":
                ws, peak = fall_windows(x, a.window, a.fall_step, a.min_peak)
                if not ws:
                    print(f"  ! {f.name}: цохилт {peak:.2f} g < {a.min_peak} g — алгаслаа")
                    continue
                if k in test_idx:  # 1–2 уналтын файлтай бол test хийхгүй, бүгд train-д
                    Xte += feats(ws); yte += [label] * len(ws); nte += len(ws)
                    test_parts.append((f.name, label, x))
                else:
                    Xtr += feats(ws); ytr += [label] * len(ws); ntr += len(ws)
            elif test_idx:
                ws = regular_windows(x, a.window, a.step)
                if k in test_idx:
                    Xte += feats(ws); yte += [label] * len(ws); nte += len(ws)
                    test_parts.append((f.name, label, x))
                else:
                    Xtr += feats(ws); ytr += [label] * len(ws); ntr += len(ws)
            else:  # цөөн файл → файл бүрийн сүүлийн хэсгийг test (давхцалгүй)
                cut = int(len(x) * (1 - a.test_frac))
                tr, te = regular_windows(x[:cut], a.window, a.step), regular_windows(x[cut:], a.window, a.step)
                Xtr += feats(tr); ytr += [label] * len(tr); ntr += len(tr)
                Xte += feats(te); yte += [label] * len(te); nte += len(te)
                test_parts.append((f.name, label, x[cut:]))
        how = "файлаар" if test_idx else "файлын сүүлийн 20%"
        print(f"  {label:9s} {len(items):2d} файл → train {ntr:4d} цонх, test {nte:4d} цонх  ({how})")
    if protocol:
        test_k = {len(protocol) - 1} if len(protocol) >= 2 else set()
        ntr = nte = ntrans = 0
        for k, (f, x, y, tr) in enumerate(protocol):
            ws = protocol_windows(x, y, tr, a.window, a.step)
            ntrans += sum(1 for _, l in ws if l == "transition")
            if k in test_k:
                Xte += feats([w for w, _ in ws]); yte += [l for _, l in ws]; nte += len(ws)
                test_parts.append((f.name, "protocol", (x, y, tr)))
            else:
                Xtr += feats([w for w, _ in ws]); ytr += [l for _, l in ws]; ntr += len(ws)
        how = "сүүлийн файлаар бодит дарааллын шалгалт" if test_k else "1 файл → бүгд train-д"
        print(f"  дараалал  {len(protocol):2d} файл → train {ntr:4d} цонх, test {nte:4d} цонх, үүнээс шилжилт {ntrans}  ({how})")
    return np.array(Xtr), np.array(ytr), np.array(Xte), np.array(yte), test_parts


def simulate(model, parts, a):
    print("\nСервертэй адил 100 мс тутам ангилсан симуляц (test хэсэг):")
    false_alarms, adl_seconds, detected, total_falls = 0, 0.0, 0, 0
    for name, label, x in parts:
        if label == "protocol":
            timeline_eval(model, name, *x, a)
            continue
        starts = list(range(0, len(x) - a.window + 1, 5))
        if not starts:
            continue
        pred = model.predict(np.array([extract_features(x[i : i + a.window]) for i in starts]))
        if label == "fall":
            total_falls += 1
            p = int(np.linalg.norm(x[:, :3], axis=1).argmax())
            near = [pr for i, pr in zip(starts, pred) if i <= p < i + a.window]
            ok = "fall" in near
            detected += ok
            print(f"  {name}: {'✓ илэрсэн' if ok else '✗ илрээгүй'}")
        else:
            fa = int((pred == "fall").sum())
            false_alarms += fa
            adl_seconds += len(x) / 50
            acc = (pred == label).mean()
            print(f"  {name}: зөв {acc:.0%}, худал уналт {fa}")
    if adl_seconds:
        print(f"  → Худал уналт: {false_alarms} удаа / {adl_seconds / 60:.1f} мин хэвийн хөдөлгөөн")
    if total_falls:
        print(f"  → Илэрсэн уналт: {detected}/{total_falls}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data"))
    ap.add_argument("--window", type=int, default=60, help="1.2 сек @ 50 Hz (lib/server/pipeline.ts WINDOW_MS-тэй ижил)")
    ap.add_argument("--step", type=int, default=30, help="50%% давхцал")
    ap.add_argument("--fall-step", type=int, default=3, help="уналтын цонхны алхам (60 мс)")
    ap.add_argument("--min-peak", type=float, default=2.0, help="уналтын цохилтын доод хязгаар (g)")
    ap.add_argument("--test-frac", type=float, default=0.2)
    a = ap.parse_args()

    files = sorted(Path(a.data).glob("*.csv"))
    if not files:
        raise SystemExit(f"{a.data} хавтаст CSV алга")
    Xtr, ytr, Xte, yte, parts = build(files, a)
    if not len(Xtr):
        raise SystemExit("Сургах цонх алга")

    mk = lambda: RandomForestClassifier(n_estimators=300, class_weight="balanced", random_state=42, n_jobs=-1)

    if len(Xte):
        model = mk().fit(Xtr, ytr)
        pred = model.predict(Xte)
        labels = [c for c in CLASSES + ["transition"] if c in set(ytr) | set(yte)]
        print("\nTest үр дүн (сургалтад ороогүй өгөгдөл):")
        print(classification_report(yte, pred, labels=labels, digits=3, zero_division=0))
        cm = confusion_matrix(yte, pred, labels=labels)
        print("Confusion matrix (мөр = жинхэнэ, багана = таамаг):")
        print("          " + " ".join(f"{c[:7]:>7s}" for c in labels))
        for c, row in zip(labels, cm):
            print(f"  {c:8s}" + " ".join(f"{v:7d}" for v in row))
        simulate(model, parts, a)

    X = np.vstack([Xtr, Xte]) if len(Xte) else Xtr
    y = np.concatenate([ytr, yte]) if len(Xte) else ytr
    final = mk().fit(X, y)

    final.n_jobs = 1
    final.window_ = a.window  # service.py үүгээр цонхны уртаа тааруулна
    out = HERE / "models" / "model.pkl"
    out.parent.mkdir(exist_ok=True)
    joblib.dump(final, out)
    print(f"\n✓ Бүх өгөгдлөөр ({len(y)} цонх: { {str(k): v for k, v in Counter(y).items()} }) сургаж хадгаллаа: {out}  (цонх {a.window} хэмжилт = {a.window / 50:g} сек)")


if __name__ == "__main__":
    main()
