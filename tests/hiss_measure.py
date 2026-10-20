"""Shared synthetic-signal helpers for measuring the hiss-reduction presets.

Layout (mono, 44.1 kHz, 25 s): gap 3 s | music 8 s | gap 3 s | music 8 s | gap 3 s,
with surface noise running through everything.  Music = steady tones, a decaying
cymbal/hi-hat train (4-16 kHz, the thing a denoiser dulls first), a quiet HF
"room tail" (-45 dBFS, easily mistaken for noise) and kick hits.
"""
import time

import numpy as np

from audio_processor import run_ffmpeg
from declick_measure import run_chain

SR = 44100
GAP_S = 3.0
MUSIC_S = 8.0
LAYOUT = [("gap", GAP_S), ("music", MUSIC_S), ("gap", GAP_S), ("music", MUSIC_S), ("gap", GAP_S)]
TONES = ((220.0, 0.06), (440.0, 0.08), (1318.5, 0.04), (3000.0, 0.02))


def _regions():
    t, out = 0.0, []
    for kind, dur in LAYOUT:
        out.append((kind, t, t + dur))
        t += dur
    return out


def _bandpass_noise(rng, n, lo, hi):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    x = np.fft.irfft(spec, n)
    return x / np.std(x)


def make_hiss(n, level_dbfs, kind="white", seed=11):
    """Surface noise at RMS ``level_dbfs``: white, pink (1/f) or 'vinyl' (pink + a
    mid/high bump, closer to a real groove)."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal(n)
    if kind != "white":
        spec = np.fft.rfft(w)
        f = np.fft.rfftfreq(n, 1 / SR)
        f[0] = f[1]
        shape = 1 / np.sqrt(f)
        if kind == "vinyl":
            shape = shape * (1 + 1.5 * np.exp(-0.5 * ((np.log(f) - np.log(4000)) / 0.7) ** 2))
        shape = shape / np.sqrt(1 + (60.0 / f) ** 4)  # a groove has no DC/sub-bass noise (rumble filter's job)
        w = np.fft.irfft(spec * shape, n)
    w = w / np.std(w)
    return (w * 10 ** (level_dbfs / 20)).astype(np.float32)


def make_signals(hiss_dbfs=-55, hiss_kind="white", seed=5):
    """Return (clean_music, hiss, regions, ghost); ghost = the very quiet HF flicks kept apart."""
    rng = np.random.default_rng(seed)
    regions = _regions()
    n = int(sum(d for _, d in LAYOUT) * SR)
    t = np.arange(n) / SR
    music = np.zeros(n)
    ghost = np.zeros(n)
    for kind, a, b in regions:
        if kind != "music":
            continue
        i0, i1 = int(a * SR), int(b * SR)
        tt = t[i0:i1]
        env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * tt)
        for f, amp in TONES:
            music[i0:i1] += amp * env * np.sin(2 * np.pi * f * tt)
        # quiet HF room tail through the whole section
        music[i0:i1] += 10 ** (-45 / 20) * _bandpass_noise(rng, i1 - i0, 5000, 14000)
        # hi-hat/cymbal train (every 0.25 s), kicks (every 0.5 s)
        for j in range(int((b - a) / 0.25)):
            s = i0 + int(j * 0.25 * SR)
            m = int(0.18 * SR)
            if s + m > i1:
                break
            k = np.arange(m)
            music[s:s + m] += 0.06 * _bandpass_noise(rng, m, 4000, 16000) * np.exp(-k / (0.05 * SR))
            if j % 2 == 1:
                # ghost hit: very quiet HF flick, ~7 dB above the hiss level
                ghost[s:s + m] += 10 ** ((hiss_dbfs + 7) / 20) * _bandpass_noise(rng, m, 4000, 16000) * np.exp(-k / (0.05 * SR))
            if j % 2 == 0:
                music[s:s + m] += 0.4 * np.sin(2 * np.pi * 55 * k / SR) * np.exp(-k / (0.03 * SR))
    hiss = make_hiss(n, hiss_dbfs, hiss_kind)
    return music.astype(np.float32), hiss, regions, ghost.astype(np.float32)


def _rms_db(x):
    return 10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-20)


def _amp(x, f):
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w)) * 2 / np.sum(w)
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    sel = (freqs >= f - 2) & (freqs <= f + 2)
    return float(np.sqrt(np.sum(spec[sel] ** 2)))


def _hiss_band_db(x, lo=250.0):
    """Level (dB re 1) of the part of ``x`` above ``lo`` Hz -- the band hiss reduction is judged in."""
    spec = np.abs(np.fft.rfft(x.astype(np.float64))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return 10 * np.log10(np.sum(spec[f >= lo]) / len(x) ** 2 * 2 + 1e-20)


def _band_energy_db(x, lo, hi):
    spec = np.abs(np.fft.rfft(x.astype(np.float64))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return 10 * np.log10(np.sum(spec[(f >= lo) & (f <= hi)]) + 1e-20)


def musical_noise_cv(x):
    """Median over 1-16 kHz bins of std/mean of the STFT power across time.  Gaussian
    noise (even after plain attenuation) gives ~1.0; a denoiser leaving isolated
    spectral spikes ("musical noise", gritty/watery residual) gives larger values."""
    n, hop = 1024, 512
    frames = np.lib.stride_tricks.sliding_window_view(x.astype(np.float64), n)[::hop]
    p = np.abs(np.fft.rfft(frames * np.hanning(n), axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    sel = (f >= 1000) & (f <= 16000)
    cv = p[:, sel].std(axis=0) / (p[:, sel].mean(axis=0) + 1e-30)
    return float(np.median(cv))


def measure(chain, sigs=None):
    """Metrics for one chain on music + hiss:

    gap_red_db   : drop (dB, positive = quieter) of the >250 Hz noise inside the gaps, edges excluded
    tone_db      : level change of the steady tones inside the music (0 = untouched)
    cymbal_db    : level change of the 4-16 kHz energy inside the music (negative = dulled)
    ghost_db     : survival of very quiet HF flicks (hiss level + 7 dB) (0 = intact)
    gap_cv       : musical-noise index of the residual in the gaps (1.0 = clean noise)
    kick_db      : peak level change of the kick hits
    seconds      : wall time of the ffmpeg run
    """
    music, hiss, regions, ghost = sigs or make_signals()
    noisy = music + hiss + ghost
    t0 = time.perf_counter()
    out = run_chain(noisy, chain)
    seconds = time.perf_counter() - t0
    base_out = run_chain(music + hiss, chain)
    gaps = [(a, b) for k, a, b in regions if k == "gap"]
    mus = [(a, b) for k, a, b in regions if k == "music"]
    red = []
    cvs = []
    for a, b in gaps:
        cvs.append(musical_noise_cv(out[int((a + 0.8) * SR):int((b - 0.8) * SR)]))
        sl = slice(int((a + 0.8) * SR), int((b - 0.8) * SR))
        red.append(_hiss_band_db(noisy[sl]) - _hiss_band_db(out[sl]))
    tone, cym, kick = [], [], []
    gh_out = out.astype(np.float64) - base_out
    gl = np.nonzero(np.abs(ghost) > 0)[0]
    ghost_db = 10 * np.log10(np.sum(gh_out[gl] ** 2) / np.sum(ghost[gl].astype(np.float64) ** 2))
    for a, b in mus:
        sl = slice(int((a + 1.0) * SR), int((b - 0.5) * SR))
        for f, _ in TONES:
            tone.append(20 * np.log10(_amp(out[sl], f) / _amp(noisy[sl], f)))
        cym.append(_band_energy_db(out[sl], 4000, 16000) - _band_energy_db(noisy[sl], 4000, 16000))
        for j in range(0, int((b - a) / 0.5)):
            s = int(a * SR + j * 0.5 * SR)
            w = slice(s, s + int(0.1 * SR))
            if w.stop <= len(out):
                kick.append(20 * np.log10(np.max(np.abs(out[w])) / np.max(np.abs(noisy[w]))))
    return {
        "gap_red_db": float(np.mean(red)),
        "gap_red_first": float(red[0]),
        "tone_db": float(np.mean(tone)),
        "tone_worst_db": float(np.min(tone)),
        "cymbal_db": float(np.mean(cym)),
        "kick_db": float(np.mean(kick)),
        "ghost_db": float(ghost_db),
        "gap_cv": float(np.mean(cvs)),
        "seconds": seconds,
    }


def noise_profile_of(hiss, regions):
    """NoiseProfile measured the way the app does it: from the file's silent stretches only."""
    import silence_analysis as sa
    from audio_processor import NoiseProfile

    segs = [hiss[int((a + 0.8) * SR):int((b - 0.8) * SR)] for k, a, b in regions if k == "gap"]
    freqs, power, _ = sa.averaged_power_spectrum(segs, SR)
    return NoiseProfile.from_analysis(sa.noise_profile(freqs, power, SR))
