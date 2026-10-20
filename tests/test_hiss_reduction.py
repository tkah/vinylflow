"""Plan 07 slice 4: measured behaviour of the hiss-reduction presets (real ffmpeg, offline).

Synthetic music (steady tones, cymbal/hi-hat train, a quiet HF room tail, kicks, very quiet HF
flicks at the hiss level) with white / pink / vinyl-shaped surface noise at -70..-46 dBFS.
The noise profile comes from the file's own gaps through ``silence_analysis``, exactly as in the
app.  Run ``pytest -s tests/test_hiss_reduction.py`` to print the table.
"""

import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from audio_processor import HISS_PRESETS, hiss_filter  # noqa: E402
from hiss_measure import make_signals, measure, noise_profile_of  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

CASES = [("white", -58), ("vinyl", -58), ("vinyl", -70), ("vinyl", -46), ("pink", -58)]


@pytest.fixture(scope="module")
def table():
    rows = {}
    for kind, level in CASES:
        sigs = make_signals(level, kind)
        prof = noise_profile_of(sigs[1], sigs[2])
        assert prof is not None
        for name in HISS_PRESETS:
            rows[(kind, level, name)] = measure(hiss_filter(name, prof), sigs)
        rows[(kind, level, "fallback")] = measure(hiss_filter("strong"), sigs)
    print("\nnoise        preset    nr   gap(dB)  tone(dB)  cymbal(dB)  ghost(dB)  kick(dB)  musical-noise  s/25s")
    for (kind, level, name), m in rows.items():
        nr = HISS_PRESETS.get(name, "-")
        print(f"{kind:5s} {level:4d}  {name:9s} {nr!s:>3}  {m['gap_red_db']:7.1f}  {m['tone_db']:8.2f}  "
              f"{m['cymbal_db']:10.2f}  {m['ghost_db']:9.2f}  {m['kick_db']:8.2f}  {m['gap_cv']:13.2f}  {m['seconds']:5.2f}")
    return rows


def test_reduction_is_monotonic_light_medium_strong(table):
    for kind, level in CASES:
        red = [table[(kind, level, n)]["gap_red_db"] for n in ("light", "medium", "strong")]
        assert red[0] + 3 < red[1] and red[1] + 3 < red[2], (kind, level, red)


def test_reduction_matches_the_preset_for_any_noise_shape_and_level(table):
    """The measured profile makes ``nr`` mean what it says: white, pink and vinyl hiss from -70
    to -46 dBFS all get the same reduction (a fixed floor does not: 2-5 dB on coloured noise)."""
    for kind, level in CASES:
        for name, nr in HISS_PRESETS.items():
            got = table[(kind, level, name)]["gap_red_db"]
            assert nr - 1.0 <= got <= nr + 2.5, (kind, level, name, got)


def test_music_survives(table):
    for (kind, level, name), m in table.items():
        if name == "fallback":
            continue
        assert abs(m["tone_db"]) < 0.3, (kind, level, name, m["tone_db"])
        assert m["cymbal_db"] > -1.5, (kind, level, name, m["cymbal_db"])
        assert m["ghost_db"] > -2.0, (kind, level, name, m["ghost_db"])
        assert m["kick_db"] > -0.5, (kind, level, name, m["kick_db"])


def test_residual_is_clean_noise_not_musical_noise(table):
    # plain Gaussian noise reads ~1.0; isolated spectral spikes ("watery"/"gritty") read well above
    for (kind, level, name), m in table.items():
        if name != "fallback":
            assert m["gap_cv"] < 1.3, (kind, level, name, m["gap_cv"])


def test_fallback_without_profile_is_gentle(table):
    """No usable silence -> afftdn's own noise tracking: erratic (0.5-10 dB depending on the
    record) but capped, and harmless to the music."""
    for kind, level in CASES:
        fb = table[(kind, level, "fallback")]
        assert fb["gap_red_db"] < 11.0, (kind, level, fb["gap_red_db"])
        assert abs(fb["tone_db"]) < 0.3 and fb["cymbal_db"] > -1.0


def test_strength_costs_no_extra_time(table):
    for kind, level in CASES:
        t = {n: table[(kind, level, n)]["seconds"] for n in HISS_PRESETS}
        assert t["strong"] < 3 * t["light"] + 0.5, t     # same filter, only the depth changes


def test_filter_strings():
    from audio_processor import NoiseProfile
    prof = NoiseProfile(-60.0, tuple([-60.0] * 15))
    for name, nr in HISS_PRESETS.items():
        f = hiss_filter(name, prof)
        assert f.startswith(f"afftdn=nr={nr}:nf=-54.0:nt=c:bn=")
        assert f.count("|") == 14
    assert hiss_filter("light").endswith("tn=1")
    assert hiss_filter("strong").startswith("afftdn=nr=12:")   # fallback cap
    with pytest.raises(ValueError):
        hiss_filter("max")


def test_why_a_per_file_profile(table):
    """The baselines the profile replaces: with afftdn's fixed floor (nf=-50) or noise tracking the
    same ``nr=20`` delivers anywhere from ~3 to 20 dB depending on the record (noisy records barely
    touched, quiet ones fully reduced - and over-reduced where the music is quiet too); the
    profile delivers the preset on every record."""
    fixed, tracked = {}, {}
    for kind, level in (("vinyl", -70), ("vinyl", -58), ("vinyl", -46), ("white", -50)):
        sigs = make_signals(level, kind)
        fixed[(kind, level)] = measure("afftdn=nr=20:nf=-50", sigs)["gap_red_db"]
        tracked[(kind, level)] = measure("afftdn=nr=20:nf=-50:tn=1", sigs)["gap_red_db"]
    prof = [table[("vinyl", lv, "strong")]["gap_red_db"] for lv in (-70, -58, -46)]
    print(f"\nfixed floor nr=20: {fixed}\ntracking nr=20:    {tracked}\nprofile strong:    {prof}")
    assert max(fixed.values()) - min(fixed.values()) > 10.0
    assert max(tracked.values()) - min(tracked.values()) > 10.0
    assert max(prof) - min(prof) < 1.0
