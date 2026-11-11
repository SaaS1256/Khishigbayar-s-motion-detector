"""
MotionCare — ML үйлчилгээ (FastAPI)

Next.js сервер ML_SERVICE_URL тохируулсан үед 2 секундийн цонхыг энд POST /predict-ээр илгээнэ.
Сургасан загвар (models/model.pkl) байхгүй бол алдаа буцааж, веб систем өөрийн baseline ангилагч руу шилжинэ.

Ажиллуулах:
    pip install -r requirements.txt
    uvicorn service:app --port 8000
    # Next.js талд: ML_SERVICE_URL=http://localhost:8000
"""
from pathlib import Path

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from features import extract_features

CLASSES = ["sitting", "standing", "walking", "running", "lying", "fall"]
MODEL_PATH = Path(__file__).parent / "models" / "model.pkl"

app = FastAPI(title="MotionCare ML")
model = joblib.load(MODEL_PATH) if MODEL_PATH.exists() else None
if model is not None:
    model.n_jobs = 1  # нэг цонхонд олон thread удаан (Windows дээр ~180 мс → ~10 мс)
# Next.js сүүлийн 3 сек-ийг илгээдэг. Загварын сурсан цонхны уртаар (train2.py → model.window_) энд тайрна.
# Хуучин train.py-ийн загварт window_ байхгүй — тэр нь 100 хэмжилтээр (2 сек) сурсан.
WINDOW = getattr(model, "window_", 100) if model is not None else None
MODEL_NAME = f"random-forest-{WINDOW / 50:g}s" if model is not None else None


class Sample(BaseModel):
    t: float
    ax: float
    ay: float
    az: float
    gx: float
    gy: float
    gz: float


class Window(BaseModel):
    deviceId: str
    samples: list[Sample]


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_PATH.name if model else None, "window": WINDOW}


@app.post("/predict")
def predict(w: Window):
    if model is None:
        raise HTTPException(503, "model not trained yet — run train.py")
    samples = w.samples[-WINDOW:] if WINDOW else w.samples
    if WINDOW and len(samples) < WINDOW // 2:
        raise HTTPException(422, f"хэмжилт хангалтгүй: {len(samples)}/{WINDOW}")
    x = np.array([[s.ax, s.ay, s.az, s.gx, s.gy, s.gz] for s in samples], dtype=np.float32)
    proba = model.predict_proba([extract_features(x)])[0]
    scores = {c: 0.0 for c in CLASSES}
    transition = 0.0
    for cls, p in zip(model.classes_, proba):
        if str(cls) == "transition":
            transition = float(p)  # суух/босох/хэвтэх шилжилт — веб талд ангиллыг солихгүй
        else:
            scores[str(cls)] = float(p)
    total = sum(scores.values())
    if total > 0:
        scores = {c: v / total for c, v in scores.items()}
    activity = max(scores, key=scores.get)
    return {"activity": activity, "scores": scores, "transition": transition, "model": MODEL_NAME}
