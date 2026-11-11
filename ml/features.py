import numpy as np


def extract_features(x: np.ndarray) -> np.ndarray:
    mag = np.linalg.norm(x[:, :3], axis=1)
    feats = []
    for col in [*x.T, mag]:
        feats += [col.mean(), col.std(), col.min(), col.max(), np.percentile(col, 25), np.percentile(col, 75)]
    spec = np.abs(np.fft.rfft(mag - mag.mean()))
    feats += [spec.argmax(), spec.max(), spec.sum()]
    return np.asarray(feats, dtype=np.float32)
