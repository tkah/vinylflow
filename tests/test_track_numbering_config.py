"""Which numbering scheme ``Config`` resolves to, and that bad values don't pass silently."""

import json

import pytest

from config import DEFAULT_TRACK_NUMBERING, Config

SEQ = "sequential_disc_per_lp"
VINYL = "vinyl"


@pytest.fixture
def settings_path(tmp_path, monkeypatch):
    monkeypatch.delenv("TRACK_NUMBERING", raising=False)
    return tmp_path / "config" / "settings.json"


def load(settings_path):
    # The .env path doesn't exist: only settings.json and the environment count here.
    return Config(env_path=settings_path.parent / "no.env", settings_path=settings_path)


def write(settings_path, content):
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(content))


def test_the_default_is_sequential(settings_path):
    assert DEFAULT_TRACK_NUMBERING == SEQ
    assert load(settings_path).track_numbering == SEQ


def test_settings_without_a_scheme_stay_on_the_default_and_are_not_rewritten(settings_path):
    """The fork has defaulted to sequential for a long time: upstream's pin to vinyl for
    older settings files must not run here, it would flip an install that never chose."""
    write(settings_path, {"DISCOGS_USER_TOKEN": "x"})
    before = settings_path.read_text()
    assert load(settings_path).track_numbering == SEQ
    assert settings_path.read_text() == before


@pytest.mark.parametrize("scheme", [SEQ, VINYL])
def test_a_saved_choice_is_kept(settings_path, scheme):
    write(settings_path, {"TRACK_NUMBERING": scheme})
    assert load(settings_path).track_numbering == scheme


def test_the_environment_applies_without_a_saved_choice(settings_path, monkeypatch):
    monkeypatch.setenv("TRACK_NUMBERING", VINYL)
    assert load(settings_path).track_numbering == VINYL


@pytest.mark.parametrize("source", ["settings", "environment"])
def test_an_unknown_scheme_warns_and_keeps_acting_as_vinyl(settings_path, monkeypatch, capsys, source):
    if source == "settings":
        write(settings_path, {"TRACK_NUMBERING": "Vinyl"})
    else:
        monkeypatch.setenv("TRACK_NUMBERING", "Vinyl")
    assert load(settings_path).track_numbering == VINYL
    assert "TRACK_NUMBERING" in capsys.readouterr().out


def test_an_empty_environment_variable_counts_as_unset(settings_path, monkeypatch):
    monkeypatch.setenv("TRACK_NUMBERING", "")
    assert load(settings_path).track_numbering == SEQ
