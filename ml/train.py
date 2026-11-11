
import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

from features import extract_features


def windows(df: pd.DataFrame, size: int, step: int):
    x = df[["ax", "ay", "az", "gx", "gy", "gz"]].to_numpy(np.float32)
    y = df["label"].to_numpy()
    for i in range(0, len(df) - size + 1, step):
        
        labels, counts = np.unique(y[i : i + size], return_counts=True)
        yield extract_features(x[i : i + size]), labels[counts.argmax()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--window", type=int, default=100, help="2 сек @ 50 Hz")
    ap.add_argument("--step", type=int, default=50, help="50 percent overlap")
    a = ap.parse_args()

    X, Y = [], []
    for f in sorted(Path(a.data).glob("*.csv")):
        for feats, label in windows(pd.read_csv(f), a.window, a.step):
            X.append(feats)
            Y.append(label)
    if not X:
        raise SystemExit(f"{a.data}/ хавтаст CSV өгөгдөл алга")

    Xtr, Xte, ytr, yte = train_test_split(np.array(X), np.array(Y), test_size=0.2, stratify=Y, random_state=42)
    model = RandomForestClassifier(n_estimators=200, random_state=42).fit(Xtr, ytr)
    pred = model.predict(Xte)
    print(classification_report(yte, pred, digits=3))
    print(confusion_matrix(yte, pred, labels=model.classes_))

    Path("models").mkdir(exist_ok=True)
    joblib.dump(model, "models/model.pkl")
    print("✓ models/model.pkl хадгалагдлаа")


if __name__ == "__main__":
    main()
