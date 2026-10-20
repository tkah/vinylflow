"""Plan 07 slice 4: measured behaviour of the mains-hum notch (real ffmpeg, offline).

Synthetic music (tones, a bass line with notes 1-3 % off the 50/60 Hz harmonics, 55 Hz kicks,
snare noise) plus hum (fundamental + 6 harmonics at -45..-55 dBFS).  The notch is linear, so
hum reduction is measured on the hum alone and music damage on the music alone.
Run ``pytest -s tests/test_hum_filter.py`` to see the tables the Q / harmonic-count choice
was made from.
"""

import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from audio_processor import HUM_HARMONICS, HUM_NOTCH_Q, hum_filter  # noqa: E402
from hum_measure import (  # noqa: E402
    candidate_chain, ghost_db, hum_reduction_db, make_music, music_damage_db, tone_gain_db,
)

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

COVERED = HUM_HARMONICS
# The synthetic bass line deliberately sits 1-3 % from every harmonic - worst case: the residual
# energy relative to the music is -8.1 dB for the chosen Q.
MUSIC_DAMAGE_BOUND_DB = -6.0


@pytest.fixture(scope="module")
def music():
    return make_music()


@pytest.mark.parametrize("f0", [50, 60])
def test_hum_reduced_by_at_least_20_db_at_every_harmonic(f0):
    red = hum_reduction_db(hum_filter(f0), f0, COVERED)
    print(f"\n{f0} Hz exact: reduction per harmonic (dB) {[round(r) for r in red]}")
    assert min(red) >= 20.0


@pytest.mark.parametrize("f0", [50, 60])
@pytest.mark.parametrize("drift", [0.001, 0.002, -0.002])
def test_hum_still_reduced_under_mains_drift(f0, drift):
    # mains frequency wanders ~0.1-0.2 %; every harmonic moves with it
    red = hum_reduction_db(hum_filter(f0), f0, COVERED, drift=drift)
    assert min(red) >= 20.0, (drift, red)


@pytest.mark.parametrize("f0", [50, 60])
def test_music_damage_is_bounded(f0, music):
    dmg = music_damage_db(hum_filter(f0), music)
    print(f"\n{f0} Hz notch: residual vs music {dmg:.1f} dB (worst-case bass line)")
    assert dmg < MUSIC_DAMAGE_BOUND_DB


@pytest.mark.parametrize("f0", [50, 60])
def test_tones_away_from_harmonics_are_untouched(f0):
    chain = hum_filter(f0)
    for f in (440.0, 1318.5, 2093.0, 80.0 if f0 == 60 else 70.0):
        assert abs(tone_gain_db(chain, f)) < 0.15, f
    # notes >= 8 % from a harmonic lose almost nothing
    for f in (110.0, 130.0, 73.0, 220.0) if f0 == 60 else (75.0, 125.0, 175.0, 220.0):
        assert tone_gain_db(chain, f) > -0.8, f


def test_a_notch_never_boosts():
    chain = hum_filter(60)
    for f in (45.0, 55.0, 65.0, 90.0, 150.0, 210.0, 270.0, 330.0, 420.0):
        assert tone_gain_db(chain, f) < 0.05, f


def test_choice_table_q_and_harmonics(music):
    """The grid the preset was picked from: Q trades hum depth under drift against bass
    damage and phase ghost; more harmonics than six add damage without removing audible hum."""
    rows = []
    for q in (12, 20, 30, 50):
        ch = candidate_chain(60, COVERED, q)
        cut = [min(hum_reduction_db(ch, 60, COVERED, drift=d)) for d in (0.001, 0.002, 0.003)]
        rows.append((q, cut, music_damage_db(ch, music), ghost_db(ch, 400)))
    print("\n  Q   cut@.1% @.2% @.3%   bass damage   ghost>400Hz")
    for q, cut, dmg, g in rows:
        print(f"{q:3d}   {cut[0]:6.0f} {cut[1]:4.0f} {cut[2]:4.0f}   {dmg:9.1f} dB   {g:8.1f} dB")
    # lower Q: more drift-proof, more damage, bigger ghost
    assert rows[0][1][1] > rows[1][1][1] > rows[2][1][1] > rows[3][1][1]
    assert rows[0][2] > rows[1][2] > rows[2][2] > rows[3][2]
    assert rows[0][3] > rows[1][3] > rows[2][3] > rows[3][3]
    chosen = dict((r[0], r) for r in rows)[HUM_NOTCH_Q]
    assert chosen[1][1] >= 20.0 and chosen[2] < MUSIC_DAMAGE_BOUND_DB


def test_extra_harmonics_cost_music(music):
    base = music_damage_db(candidate_chain(60, HUM_HARMONICS, HUM_NOTCH_Q), music)
    more = music_damage_db(candidate_chain(60, 10, HUM_NOTCH_Q), music)
    fewer = music_damage_db(candidate_chain(60, 3, HUM_NOTCH_Q), music)
    print(f"\nharmonics 3 / {HUM_HARMONICS} / 10: damage {fewer:.1f} / {base:.1f} / {more:.1f} dB")
    assert fewer <= base <= more          # every extra notch costs a little more bass
    assert more - base < 1.5              # ...but little: the choice is about hum, not damage


def test_zero_phase_form_for_the_removed_render():
    """Forward-backward notch: same hum removal (deeper), but no phase ghost of the music in
    ``input - output`` -- the render of what the clean-up took out must hold the hum, not the song."""
    plain, zp = hum_filter(60), hum_filter(60, zero_phase=True)
    g_plain = (ghost_db(plain, 400), ghost_db(plain, 1000))
    g_zp = (ghost_db(zp, 400), ghost_db(zp, 1000))
    print(f"\nghost >400 Hz / >1 kHz: notch {g_plain[0]:.1f}/{g_plain[1]:.1f} dB, "
          f"zero-phase {g_zp[0]:.1f}/{g_zp[1]:.1f} dB")
    assert g_zp[0] < g_plain[0] - 15.0 and g_zp[1] < g_plain[1] - 30.0
    assert g_zp[0] < -40.0 and g_zp[1] < -65.0
    assert min(hum_reduction_db(zp, 60, COVERED)) >= 20.0
    assert min(hum_reduction_db(zp, 60, COVERED, drift=0.002)) >= min(hum_reduction_db(plain, 60, COVERED, drift=0.002))
