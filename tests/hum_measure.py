"""Shared synthetic-signal helpers for measuring the mains-hum notch.

Music-like bed (tones, a bass line with notes near but not on the 50/60 Hz
harmonics, kick drums with a ~55 Hz body, noisy snare-like transients) plus a
mains hum (fundamental + harmonics at -50..-35 dBFS).

Because the notch is linear, hum reduction is measured on the hum alone and
music damage on the music alone (the sum behaves identically).
"""
import numpy as np

from declick_measure import run_chain

SR = 44100
SECONDS = 20

# peak level (dBFS) of harmonics 1..7 of the hum: strong low orders, decaying tail.
HUM_LEVELS_DB = (-45, -40, -42, -50, -48, -55, -55)

# bass line, Hz: near-but-not-on 50 Hz harmonics (49, 98, 146.8, 196, 246.9: ~2% off) and
# near 60 Hz harmonics (61.7, 123.5, 185 (F#3), 246.9 ...).
BASS_NOTES = (49.0, 55.0, 61.74, 65.41, 73.42, 98.0, 110.0, 116.54, 123.47, 146.83,
              164.81, 185.0, 196.0, 220.0, 246.94)


def make_hum(f0, seconds=SECONDS, sr=SR, levels=HUM_LEVELS_DB, drift=0.0, seed=3):
    """Hum at f0 and harmonics; ``drift`` scales every frequency (0.002 = +0.2 %)."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    x = np.zeros(len(t))
    for k, db in enumerate(levels, start=1):
        x += 10 ** (db / 20) * np.sin(2 * np.pi * f0 * (1 + drift) * k * t + rng.uniform(0, 6.28))
    return x.astype(np.float32)


def make_music(seconds=SECONDS, sr=SR, seed=7):
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    music = np.zeros(n)
    # pads/leads: none of these sit on a 50 or 60 Hz harmonic below 400 Hz
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t)
    for f, a in ((440.0, 0.08), (523.25, 0.06), (659.26, 0.05), (880.0, 0.04), (1318.5, 0.03), (2093.0, 0.02)):
        music += a * env * np.sin(2 * np.pi * f * t)
    # bass line: 0.5 s notes, exponential decay, 2nd harmonic
    note_len = int(0.5 * sr)
    for i in range(n // note_len):
        f = BASS_NOTES[i % len(BASS_NOTES)]
        s = i * note_len
        k = np.arange(note_len) / sr
        e = np.exp(-k / 0.35) * np.minimum(1, k / 0.01)
        music[s:s + note_len] += 0.25 * e * (np.sin(2 * np.pi * f * k) + 0.4 * np.sin(2 * np.pi * 2 * f * k))
    # kick (decaying ~55 Hz body) and snare (noise crack) hits
    for j in range(int(seconds / 0.5)):
        s = int((0.25 + j * 0.5) * sr)
        m = int(0.12 * sr)
        k = np.arange(m)
        if s + m >= n:
            break
        if j % 2 == 0:
            f = 55.0 * (1 + 0.6 * np.exp(-k / (0.01 * sr)))
            music[s:s + m] += 0.5 * np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-k / (0.04 * sr))
        else:
            noise = np.convolve(rng.standard_normal(m), np.ones(4) / 4, mode="same")
            music[s:s + m] += 0.35 * noise * np.exp(-k / (0.02 * sr))
    return np.clip(music, -0.9, 0.9).astype(np.float32)


def candidate_chain(f0, harmonics, q, zero_phase=False):
    """The shipped hum filter (biquad ``bandreject`` cascade) with other parameters."""
    from audio_processor import hum_filter
    return hum_filter(f0, zero_phase, q, harmonics)


def _band_amp(x, f, sr=SR, half_bw=1.5):
    """Amplitude of the sinusoid near ``f`` (peak), from a Hann FFT over ``x``."""
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w)) * 2 / np.sum(w)
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    sel = (freqs >= f - half_bw) & (freqs <= f + half_bw)
    return float(np.sqrt(np.sum(spec[sel] ** 2)))


def hum_reduction_db(chain, f0, harmonics=7, drift=0.0, sr=SR):
    """Per-harmonic reduction in dB of a hum through ``chain`` (last half of the
    clip, after settling).  Returns a list for harmonics 1..harmonics."""
    hum = make_hum(f0, drift=drift, sr=sr)
    out = run_chain(hum, chain)
    half = len(hum) // 2
    res = []
    for k in range(1, harmonics + 1):
        fk = f0 * (1 + drift) * k
        a_in = _band_amp(hum[half:], fk, sr)
        a_out = max(_band_amp(out[half:], fk, sr), 1e-12)
        res.append(20 * np.log10(a_in / a_out))
    return res


def music_damage_db(chain, music=None):
    """Residual energy of (chain(music) - music) relative to the music, in dB
    (more negative = less damage), plus the same restricted to 40-400 Hz."""
    music = make_music() if music is None else music
    out = run_chain(music, chain)
    err = out.astype(np.float64) - music
    skip = SR  # ignore the first second (filter settling)
    e_all = 10 * np.log10(np.sum(err[skip:] ** 2) / np.sum(music[skip:].astype(np.float64) ** 2))
    return float(e_all)


def tone_gain_db(chain, freq, sr=SR, seconds=6):
    """Steady-state gain (dB) of a unit sine at ``freq`` through the chain."""
    t = np.arange(int(seconds * sr)) / sr
    x = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    out = run_chain(x, chain)
    h = len(x) // 2
    return 20 * np.log10(_band_amp(out[h:], freq, sr, 1.0) / _band_amp(x[h:], freq, sr, 1.0))


def pink_band(lo, hi, seconds=20, sr=SR, seed=2, rms=0.1):
    """1/f noise limited to [lo, hi] Hz: bass-heavy broadband stand-in for music."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / sr)
    f[0] = f[1]
    spec = spec / np.sqrt(f)
    spec[(f < lo) | (f > hi)] = 0
    x = np.fft.irfft(spec, n)
    return (x / np.std(x) * rms).astype(np.float32)


def ghost_db(chain, lo=400.0, hi=12000.0):
    """Energy of ``input - output`` relative to the input for noise confined to [lo, hi] Hz, i.e.
    far from every notch: pure filter phase/skirt leakage.  This is what the "Removed" render
    would show of the music; the lower the better."""
    x = pink_band(lo, hi)
    y = run_chain(x, chain)
    r = (x - y)[SR:].astype(np.float64)
    return float(10 * np.log10(np.mean(r ** 2) / np.mean(x[SR:].astype(np.float64) ** 2)))
