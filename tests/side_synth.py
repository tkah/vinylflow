"""Synthetic record side for the hum / noise analysis tests: lead-in, music, gap, music, run-out.

Hum (if any) runs through the whole recording like a real ground loop; surface noise too; the
optional ``bass_hz`` note is played *in the music only* (never in the silent stretches).
"""
import numpy as np

from hiss_measure import make_hiss
from hum_measure import make_hum

SR = 44100
LAYOUT = (("silence", 3.0), ("music", 6.0), ("silence", 3.0), ("music", 6.0), ("silence", 3.0))


def make_side(hum=None, hum_gain_db=0.0, bass_hz=None, hiss_dbfs=-58.0, hiss_kind="vinyl", seed=1, sr=SR):
    secs = sum(d for _, d in LAYOUT)
    n = int(secs * sr)
    t = np.arange(n) / sr
    x = make_hiss(n, hiss_dbfs, hiss_kind, seed=seed).astype(np.float64)
    if hum:
        x += make_hum(hum, seconds=secs, sr=sr, seed=seed) * 10 ** (hum_gain_db / 20)
    pos = 0.0
    for kind, dur in LAYOUT:
        if kind == "music":
            i0, i1 = int(pos * sr), int((pos + dur) * sr)
            tt = t[i0:i1]
            env = 0.7 + 0.3 * np.sin(2 * np.pi * 0.4 * tt)
            for f, a in ((330.0, 0.10), (495.0, 0.06), (1000.0, 0.04)):
                x[i0:i1] += a * env * np.sin(2 * np.pi * f * tt)
            if bass_hz:
                x[i0:i1] += 0.3 * np.sin(2 * np.pi * bass_hz * tt) + 0.1 * np.sin(2 * np.pi * 2 * bass_hz * tt)
        pos += dur
    return np.clip(x, -0.95, 0.95).astype(np.float32)
