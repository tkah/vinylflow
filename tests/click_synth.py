"""Synthetic vinyl-like signal with known click times, for detection tests/tuning.

Music bed alternates loud / quiet 20 s sections (tones + slow envelope + hiss);
clicks are 1-3 sample impulses at known times, with amplitudes that scale with
the local section (so loud sections get bigger pops, quiet ones faint ticks).
"""
import wave

import numpy as np

SR = 44100


def make_clicky(seconds=150, n_clicks=60, seed=11, section_s=20.0):
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)
    t = np.arange(n) / SR
    loud = ((t // section_s).astype(int) % 2 == 0)
    gain = np.where(loud, 1.0, 0.12)
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t)
    music = sum(a * np.sin(2 * np.pi * f * t) for f, a in
                ((110, 0.12), (220, 0.10), (330, 0.08), (440, 0.08), (660, 0.05), (1320, 0.03)))
    music = music * env * gain
    hiss = rng.standard_normal(n) * 0.004
    clean = np.clip(music + hiss, -0.9, 0.9)
    noisy = clean.copy()
    positions, amps = [], []
    while len(positions) < n_clicks:
        p = int(rng.integers(SR, n - SR))
        if any(abs(p - q) < SR // 2 for q in positions):
            continue
        # keep some away from chunk seams being trivially absent: also place near 60 s/120 s
        positions.append(p)
    # force clicks right at/near the seams of 60 s chunks (overlap regions)
    for seam in (60.0, 120.0):
        if seam > seconds - 2:
            continue
        for off in (-0.3, 0.2, 0.0):
            p = int((seam + off) * SR)
            if all(abs(p - q) > SR // 2 for q in positions):
                positions.append(p)
    positions.sort()
    for p in positions:
        width = int(rng.integers(1, 4))
        sign = 1.0 if rng.random() < 0.5 else -1.0
        base = 0.5 if loud[p] else 0.08
        amp = float(base * np.exp(rng.uniform(np.log(0.3), np.log(1.2))))
        noisy[p:p + width] += sign * amp
        amps.append(amp)
    noisy = np.clip(noisy, -1.0, 1.0)
    return noisy.astype(np.float32), [p / SR for p in positions], amps


def write_wav(path, samples, sr=SR, stereo=True):
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    if stereo:
        pcm = np.repeat(pcm[:, None], 2, axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2 if stereo else 1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def match(found, truth, tol=0.01):
    """(recall, precision, duplicates) of ``found`` event times vs ``truth``."""
    truth = list(truth)
    hit = set()
    matched_found = 0
    for f in found:
        j = min(range(len(truth)), key=lambda k: abs(truth[k] - f)) if truth else None
        if j is not None and abs(truth[j] - f) <= tol:
            matched_found += 1
            hit.add(j)
    recall = len(hit) / len(truth) if truth else 1.0
    precision = matched_found / len(found) if found else 1.0
    return recall, precision, matched_found - len(hit)
