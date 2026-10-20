"""
VinylFlow - Configuration Management

Loads settings from .env file and provides configuration defaults.
Handles Discogs API credentials, audio processing parameters, and output settings.
"""

import os
import json
from pathlib import Path
from dotenv import load_dotenv

# Change this constant to flip the default for new installs.
# "sequential_disc_per_lp" — A+B share disc 1, C+D share disc 2, etc. TRACKNUMBER
#                            is sequential across both sides of each LP. Single LP
#                            appears as 1 disc. VINYLPOSITION custom tag preserved.
# "vinyl"                  — TRACKNUMBER="A1" (legacy behaviour, no DISCNUMBER written).
DEFAULT_TRACK_NUMBERING = "vinyl"
OUTPUT_FORMATS = ("flac", "mp3", "aiff")
BIT_DEPTHS = ("source", "24")
DECLICK_LEVELS = ("off", "light", "medium", "strong")
HISS_LEVELS = ("off", "light", "medium", "strong")
HUM_FREQS = (50, 60)


class Config:
    """Configuration manager for VinylFlow."""

    def __init__(self, env_path=None, settings_path=None):
        """
        Initialize configuration with fallback chain:
        1. settings.json (persistent, user-editable via UI)
        2. .env file (backward compatibility)
        3. Environment variables (Docker)

        Args:
            env_path: Optional path to .env file. If None, looks in current directory.
            settings_path: Optional path to settings.json. If None, uses config/settings.json.
        """
        # Store paths for reload
        if env_path is None:
            env_path = Path(__file__).parent / ".env"
        else:
            env_path = Path(env_path)

        if settings_path is None:
            config_dir_env = os.getenv("VINYLFLOW_CONFIG_DIR")
            if config_dir_env:
                settings_path = Path(config_dir_env) / "settings.json"
            else:
                settings_path = Path(__file__).parent / "config" / "settings.json"
        else:
            settings_path = Path(settings_path)

        self._env_path = env_path
        self._settings_path = settings_path

        # Load .env file if it exists
        if env_path.exists():
            load_dotenv(env_path, override=True)

        # Load JSON settings (takes precedence over .env)
        json_settings = self._load_from_json(settings_path)

        # Discogs API settings (priority: JSON > env var > default)
        self.discogs_token = (
            json_settings.get('DISCOGS_USER_TOKEN') or
            os.getenv("DISCOGS_USER_TOKEN", "")
        )
        self.discogs_user_agent = (
            json_settings.get('DISCOGS_USER_AGENT') or
            os.getenv("DISCOGS_USER_AGENT", "VinylFlow/1.0")
        )

        # Output settings
        self.default_output_dir = (
            json_settings.get('DEFAULT_OUTPUT_DIR') or
            os.getenv("DEFAULT_OUTPUT_DIR", str(Path.home() / "Music" / "new 12-inches"))
        )

        # Import folder: files here are referenced in place instead of uploaded.
        # Read-only over the API (never in ConfigUpdate): set via settings.json or env.
        self.import_dir = (
            json_settings.get('IMPORT_DIR') or
            os.getenv("VINYLFLOW_IMPORT_DIR") or
            None
        )

        # Audio processing settings
        self.default_silence_threshold = float(os.getenv("DEFAULT_SILENCE_THRESHOLD", "-40"))
        self.default_min_silence_duration = float(os.getenv("DEFAULT_MIN_SILENCE_DURATION", "1.5"))
        self.default_min_track_length = float(os.getenv("DEFAULT_MIN_TRACK_LENGTH", "30"))
        self.default_flac_compression = int(os.getenv("DEFAULT_FLAC_COMPRESSION", "8"))

        # Temp file management
        self.temp_ttl_hours = float(os.getenv("TEMP_TTL_HOURS", "2"))

        # Track numbering scheme
        self.track_numbering = (
            json_settings.get("TRACK_NUMBERING")
            or os.getenv("TRACK_NUMBERING", DEFAULT_TRACK_NUMBERING)
        )

        # Remembered export defaults (output format, rumble/declick, album gain)
        output_format = json_settings.get("OUTPUT_FORMAT") or os.getenv("OUTPUT_FORMAT", "flac")
        self.output_format = output_format if output_format in OUTPUT_FORMATS else "flac"
        # Audio processing: rumble filter + click/pop removal strength. These
        # replace the old RESTORATION_LEVEL (1 -> rumble on + declick "light");
        # it is only consulted when the new keys are absent.
        try:
            legacy_level = int(
                json_settings.get("RESTORATION_LEVEL", os.getenv("RESTORATION_LEVEL", "0"))
            )
        except (TypeError, ValueError):
            legacy_level = 0
        legacy_on = legacy_level == 1
        self.rumble_filter = self._as_bool(
            json_settings.get("RUMBLE_FILTER", os.getenv("RUMBLE_FILTER")), legacy_on
        )
        declick = str(
            json_settings.get("DECLICK") or os.getenv("DECLICK") or ("light" if legacy_on else "off")
        ).lower()
        self.declick = declick if declick in DECLICK_LEVELS else ("light" if legacy_on else "off")
        # Hum removal (mains notch) and hiss reduction: both off by default.  The hum
        # frequency defaults to 60 Hz; the hiss strength is remembered separately so
        # toggling the feature off and on keeps the last chosen strength.
        self.hum_filter = self._as_bool(
            json_settings.get("HUM_FILTER", os.getenv("HUM_FILTER")), False
        )
        try:
            hum_freq = int(json_settings.get("HUM_FREQ") or os.getenv("HUM_FREQ") or 60)
        except (TypeError, ValueError):
            hum_freq = 60
        self.hum_freq = hum_freq if hum_freq in HUM_FREQS else 60
        hiss = str(json_settings.get("HISS_REDUCTION") or os.getenv("HISS_REDUCTION") or "off").lower()
        self.hiss_reduction = hiss if hiss in HISS_LEVELS else "off"
        strength = str(json_settings.get("HISS_STRENGTH") or os.getenv("HISS_STRENGTH") or "").lower()
        if strength not in HISS_LEVELS or strength == "off":
            strength = self.hiss_reduction if self.hiss_reduction != "off" else "light"
        self.hiss_strength = strength
        bit_depth = str(json_settings.get("BIT_DEPTH") or os.getenv("BIT_DEPTH", "source"))
        self.bit_depth = bit_depth if bit_depth in BIT_DEPTHS else "source"
        # Loudness: album gain (off by default), ReplayGain tags (on by default)
        self.album_gain = self._as_bool(
            json_settings.get("ALBUM_GAIN", os.getenv("ALBUM_GAIN")), False
        )
        self.replaygain = self._as_bool(
            json_settings.get("REPLAYGAIN", os.getenv("REPLAYGAIN")), True
        )

    @staticmethod
    def _as_bool(value, default: bool) -> bool:
        if value is None or value == "":
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")

    def validate(self):
        """
        Validate configuration.

        Returns:
            tuple: (is_valid, error_message)
        """
        if not self.discogs_token:
            return False, "DISCOGS_USER_TOKEN not set in .env file"

        if self.default_flac_compression < 0 or self.default_flac_compression > 8:
            return False, "FLAC compression level must be between 0 and 8"

        if self.default_silence_threshold > 0:
            return False, "Silence threshold should be negative (dB)"

        if self.default_min_silence_duration <= 0:
            return False, "Minimum silence duration must be positive"

        if self.default_min_track_length <= 0:
            return False, "Minimum track length must be positive"

        if self.temp_ttl_hours <= 0:
            return False, "Temp file TTL must be positive"

        return True, None

    def test_discogs_connection(self):
        """
        Test Discogs API connection with current token.

        Returns:
            tuple: (success, message)
        """
        try:
            import discogs_client

            client = discogs_client.Client(self.discogs_user_agent, user_token=self.discogs_token)
            identity = client.identity()
            return True, f"Connected as: {identity.username}"
        except Exception as e:
            return False, f"Discogs connection failed: {str(e)}"

    def _load_from_json(self, settings_path: Path) -> dict:
        """
        Load settings from JSON file if it exists.

        Args:
            settings_path: Path to settings.json file

        Returns:
            dict: Settings dictionary, or empty dict if file doesn't exist
        """
        if settings_path.exists():
            try:
                with open(settings_path, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Warning: Failed to load settings.json: {e}")
        return {}

    def _write_settings(self, updates: dict) -> bool:
        """Merge *updates* into settings.json and write to disk."""
        settings_path = Path(self._settings_path)
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings = {}
        if settings_path.exists():
            try:
                with open(settings_path, 'r') as f:
                    settings = json.load(f)
            except Exception:
                pass
        settings.update(updates)
        try:
            with open(settings_path, 'w') as f:
                json.dump(settings, f, indent=2)
            return True
        except Exception as e:
            print(f"Failed to save settings: {e}")
            return False

    def save_token(self, token: str, user_agent: str = None) -> bool:
        updates = {'DISCOGS_USER_TOKEN': token}
        if user_agent:
            updates['DISCOGS_USER_AGENT'] = user_agent
        return self._write_settings(updates)

    def save_output_dir(self, output_dir: str) -> bool:
        return self._write_settings({'DEFAULT_OUTPUT_DIR': output_dir})

    def save_track_numbering(self, scheme: str) -> bool:
        return self._write_settings({'TRACK_NUMBERING': scheme})

    def save_output_format(self, fmt: str) -> bool:
        return self._write_settings({'OUTPUT_FORMAT': fmt})

    def save_bit_depth(self, bit_depth: str) -> bool:
        return self._write_settings({'BIT_DEPTH': bit_depth})

    def save_rumble_filter(self, enabled: bool) -> bool:
        return self._write_settings({'RUMBLE_FILTER': bool(enabled)})

    def save_declick(self, level: str) -> bool:
        return self._write_settings({'DECLICK': level})

    def save_hum_filter(self, enabled: bool) -> bool:
        return self._write_settings({'HUM_FILTER': bool(enabled)})

    def save_hum_freq(self, freq: int) -> bool:
        return self._write_settings({'HUM_FREQ': int(freq)})

    def save_hiss_reduction(self, level: str) -> bool:
        """Persist the hiss setting; a real strength is also remembered as ``hiss_strength``."""
        updates = {'HISS_REDUCTION': level}
        if level != "off":
            updates['HISS_STRENGTH'] = level
        return self._write_settings(updates)

    def save_hiss_strength(self, level: str) -> bool:
        return self._write_settings({'HISS_STRENGTH': level})

    @property
    def restoration_level(self) -> int:
        """Legacy 0/1 view: 1 when any rumble/declick processing is on."""
        return 1 if (self.rumble_filter or self.declick != "off") else 0

    def save_album_gain(self, enabled: bool) -> bool:
        return self._write_settings({'ALBUM_GAIN': bool(enabled)})

    def save_replaygain(self, enabled: bool) -> bool:
        return self._write_settings({'REPLAYGAIN': bool(enabled)})

    def reload(self):
        """
        Reload configuration from all sources (settings.json, .env, environment).
        """
        self.__init__(env_path=self._env_path, settings_path=self._settings_path)

    def __repr__(self):
        """String representation of config (safe - no token)."""
        return (
            f"Config(\n"
            f"  discogs_token={'*' * len(self.discogs_token) if self.discogs_token else 'NOT SET'},\n"
            f"  output_dir={self.default_output_dir},\n"
            f"  silence_threshold={self.default_silence_threshold}dB,\n"
            f"  min_silence_duration={self.default_min_silence_duration}s,\n"
            f"  min_track_length={self.default_min_track_length}s,\n"
            f"  flac_compression={self.default_flac_compression},\n"
            f"  temp_ttl_hours={self.temp_ttl_hours}h\n"
            f")"
        )


def create_default_env_file(path=None):
    """
    Create a default .env template file.

    Args:
        path: Path where to create the .env file. Defaults to current directory.
    """
    if path is None:
        path = Path.cwd() / ".env"
    else:
        path = Path(path)

    template = """# VinylFlow Configuration

# Discogs API Settings
# Get your token from: https://www.discogs.com/settings/developers
DISCOGS_USER_TOKEN=your_token_here
DISCOGS_USER_AGENT=VinylFlow/1.0

# Output Settings
DEFAULT_OUTPUT_DIR=/app/output

# Audio Processing Settings
# Silence threshold in dB (negative value)
DEFAULT_SILENCE_THRESHOLD=-40

# Minimum silence duration in seconds to consider as track boundary
DEFAULT_MIN_SILENCE_DURATION=1.5

# Minimum track length in seconds (filter out false positives)
DEFAULT_MIN_TRACK_LENGTH=30

# FLAC compression level (0-8, higher = more compression)
DEFAULT_FLAC_COMPRESSION=8
"""

    if path.exists():
        raise FileExistsError(f"{path} already exists. Not overwriting.")

    path.write_text(template)
    return path
