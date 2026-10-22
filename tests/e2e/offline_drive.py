"""Drive the API surface end-to-end against offline_server.py (offline, no Discogs).

Run inside the network-less container — see .claude/skills/verify/SKILL.md."""
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from mutagen.flac import FLAC

B = "http://127.0.0.1:8000"
WAV = Path("/tmp/verify/Test Récord – Side A.wav")
results = []


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def req(method, path, body=None, headers=None, raw=False):
    data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
    h = {"Content-Type": "application/json"} if isinstance(body, (dict, list)) else {}
    h.update(headers or {})
    r = urllib.request.Request(B + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            content = resp.read()
            return resp.status, dict(resp.headers), (content if raw else json.loads(content or b"null"))
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode(errors="replace")


def multipart(path):
    boundary = uuid.uuid4().hex
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
            f"filename*=utf-8''{urllib.parse.quote(path.name)}; filename=\"{path.name}\"\r\n"
            "Content-Type: audio/wav\r\n\r\n").encode()
    body = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


import urllib.parse  # noqa: E402

# 1. upload
body, h = multipart(WAV)
st, _, up = req("POST", "/api/upload", body, h)
f = up["files"][0]
fid = f["id"]
check("upload", st == 200 and abs(f["duration"] - 126.0) < 0.1, f"duration={f['duration']}")

# 2. background scan (music span)
for _ in range(100):
    st, _, sc = req("GET", f"/api/scan/{fid}")
    if sc.get("ready"):
        break
    time.sleep(0.2)
check("scan ready", sc.get("ready") is True,
      f"music {sc.get('music_start'):.2f}-{sc.get('music_end'):.2f} ({sc.get('music_duration'):.2f}s)")

# 3. silence-only analyze
st, _, an = req("POST", "/api/analyze", {"file_id": fid})
starts = [round(t["start"]) for t in an.get("tracks", [])]
check("analyze (silence only)", st == 200 and len(starts) == 3, f"starts={starts}")

# 4. guided with Discogs lengths
t0 = time.time()
st, _, g = req("POST", "/api/analyze-guided", {"file_id": fid, "expected_tracks": 3, "durations": [40, 40, 40]})
dt = time.time() - t0
snapped = sum(1 for b in g.get("boundaries", []) if b.get("snapped"))
check("analyze-guided durations", st == 200 and g.get("method") == "durations" and len(g["tracks"]) == 3 and snapped == 2,
      f"tracks={[(round(t['start'],1), round(t['end'],1)) for t in g.get('tracks', [])]} snapped={snapped} {dt*1000:.0f}ms")
guided_tracks = g["tracks"]

# 5. peaks
st, _, pk = req("GET", f"/api/waveform-peaks/{fid}", raw=True)
check("waveform-peaks", st == 200 and len(pk) > 1000, f"{len(pk)} bytes")

# 6. audio: the source is pinned on first request, so wait for the MP3 preconvert first
mp3 = Path("/tmp/uploads") / fid / "full.mp3"
for _ in range(300):
    if mp3.exists():
        break
    time.sleep(0.2)
for _ in range(5):
    st, hd, _ = req("GET", f"/api/audio/{fid}", raw=True, headers={"Range": "bytes=0-1023"})
    if hd.get("content-type") == "audio/mpeg":
        break
    time.sleep(0.2)
cd = hd.get("content-disposition", "")
check("audio mp3 + RFC5987", hd.get("content-type") == "audio/mpeg" and "utf-8''" in cd, f"{st} {hd.get('content-type')}")

# 7. preview cache + explicit range for a track the backend doesn't know
req("GET", f"/api/preview/{fid}/3", raw=True)
t0 = time.time()
st, _, _ = req("GET", f"/api/preview/{fid}/3", raw=True)
check("preview cached", st == 200 and (time.time() - t0) < 0.2, f"{(time.time()-t0)*1000:.0f}ms")
st, _, _ = req("GET", f"/api/preview/{fid}/9?start=10&end=20", raw=True)
check("preview explicit range (manual split)", st == 200, f"status={st}")

# 8. restoration A/B test
st, _, ab = req("POST", "/api/restoration-test", {"file_id": fid, "start": guided_tracks[0]["start"],
                "end": guided_tracks[0]["end"], "rumble": True, "declick": "medium", "album_gain": True,
                "album_ranges": [[t["start"], t["end"]] for t in guided_tracks]})
ok = st == 200
if ok:
    s1, _, a = req("GET", ab["original_url"], raw=True)
    s2, _, p = req("GET", ab["processed_url"], raw=True)
    ok = s1 == 200 and s2 == 200 and a[:4] == b"fLaC" and p[:4] == b"fLaC"
check("restoration-test A/B", ok, f"orig {ab.get('original_lufs')} LUFS, proc {ab.get('processed_lufs')} LUFS, gain {ab.get('gain_db')} dB" if isinstance(ab, dict) else ab)
# 8b. "Removed" residual: served, FLAC, 24-bit, quieter than the original
rurl = ab.get("removed_url") if isinstance(ab, dict) else None
s3, _, rd = req("GET", rurl, raw=True) if rurl else (0, None, b"")
bps = (((rd[20] & 1) << 4) | (rd[21] >> 4)) + 1 if len(rd) > 22 else 0
rl, ol = ab.get("removed_lufs"), ab.get("original_lufs")
check("restoration-test removed residual", s3 == 200 and rd[:4] == b"fLaC" and bps == 24
      and (rl is None or (ol is not None and rl < ol)) and "gain" not in str(ab.get("removed_url")),
      f"status={s3} bits={bps} removed {rl} LUFS vs original {ol} LUFS, peak {ab.get('removed_peak_dbfs')}")
st, _, _ = req("GET", f"/api/restoration-test/{fid}/..%2F..%2Fetc%2Fpasswd", raw=True)
check("restoration-test rejects traversal", st in (400, 404), f"status={st}")

# 9. settings round-trip
st, _, c = req("PUT", "/api/config", {"bit_depth": "24", "album_gain": False, "replaygain": True})
st2, _, c2 = req("GET", "/api/config")
check("config bit_depth round-trip", st == 200 and c2.get("bit_depth") == "24", f"bit_depth={c2.get('bit_depth')}")
req("PUT", "/api/config", {"bit_depth": "source"})
st, _, c = req("PUT", "/api/config", {"rumble_filter": True, "declick": "strong"})
st2, _, c2 = req("GET", "/api/config")
check("config rumble/declick round-trip", st == 200 and c2.get("rumble_filter") is True and c2.get("declick") == "strong",
      f"rumble={c2.get('rumble_filter')} declick={c2.get('declick')}")
req("PUT", "/api/config", {"restoration_level": 0})
st, _, c = req("PUT", "/api/config", {"hum_filter": True, "hum_freq": 50, "hiss_reduction": "medium"})
st2, _, c2 = req("GET", "/api/config")
check("config hum/hiss round-trip", st == 200 and c2.get("hum_filter") is True and c2.get("hum_freq") == 50
      and c2.get("hiss_reduction") == "medium" and c2.get("hiss_strength") == "medium",
      f"hum={c2.get('hum_filter')}@{c2.get('hum_freq')} hiss={c2.get('hiss_reduction')}/{c2.get('hiss_strength')}")
req("PUT", "/api/config", {"hiss_reduction": "off"})
st, _, c3 = req("GET", "/api/config")
check("config hiss strength remembered while off", c3.get("hiss_reduction") == "off" and c3.get("hiss_strength") == "medium")
st, _, _ = req("PUT", "/api/config", {"hum_freq": 55})
check("config rejects hum_freq 55", st == 400)
req("PUT", "/api/config", {"hum_filter": False, "hum_freq": 60, "hiss_strength": "light"})

# 9b. click detection: a second, 70 s upload with 5 injected clicks (the verify WAV has none)
import wave  # noqa: E402

CLICKS_WAV = Path("/tmp/verify/clicks.wav")
sr = 44100
tt = np.arange(sr * 70) / sr
sig = 0.2 * np.sin(2 * np.pi * 330 * tt) + np.random.default_rng(3).standard_normal(len(tt)) * 0.003
truth = [8.5, 21.2, 40.7, 55.05, 66.3]
for ct in truth:
    sig[int(ct * sr):int(ct * sr) + 2] += 0.6
pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2")
with wave.open(str(CLICKS_WAV), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
body, h = multipart(CLICKS_WAV)
st, _, up2 = req("POST", "/api/upload", body, h)
cid = up2["files"][0]["id"]
st, _, started = req("POST", f"/api/clicks/{cid}", {"declick": "off"})
check("clicks start (off scans at medium)", st == 200 and started.get("strength") == "medium"
      and started.get("requested") == "off", f"{started.get('status')} strength={started.get('strength')}")
res = {}
for _ in range(300):
    st, _, res = req("GET", f"/api/clicks/{cid}?declick=off")
    if res.get("status") in ("done", "error"):
        break
    time.sleep(0.3)
found = res.get("times", [])
hits = sum(1 for ct in truth if any(abs(f - ct) < 0.03 for f in found))
check("clicks poll -> done", res.get("status") == "done" and hits >= 4,
      f"{len(found)} found, {hits}/{len(truth)} matched, strength={res.get('strength')}")
t0 = time.time()
st, _, again = req("POST", f"/api/clicks/{cid}", {"declick": "medium"})
check("clicks cached (no rescan)", again.get("status") == "done" and again.get("times") == found and (time.time() - t0) < 1.0,
      f"{(time.time()-t0)*1000:.0f}ms")
req("DELETE", f"/api/queue/{cid}")

# 10. process (seeded release, no network) with rumble + light declick + ReplayGain
st, _, pr = req("POST", "/api/process", {
    "file_id": fid, "release_id": 424242,
    "track_mapping": [{"detected": t["number"], "discogs": f"A{t['number']}"} for t in guided_tracks],
    "track_boundaries": [dict(t, declick="strong") if t["number"] == 2 else t for t in guided_tracks],
    "output_format": "flac",
    "rumble_filter": True, "declick": "light", "album_gain": False, "replaygain": True})
job = pr.get("job_id") if isinstance(pr, dict) else None
status = None
for _ in range(300):
    st, _, js = req("GET", f"/api/process/{job}")
    status = js.get("status") if isinstance(js, dict) else None
    if status in ("complete", "completed", "failed", "error"):
        break
    time.sleep(0.5)
check("process job", status in ("complete", "completed"), f"status={status} {js.get('error') or ''}")

# 11. outputs: duration, dominant frequency, depth, tags, ReplayGain
outs = sorted(Path("/tmp/output").rglob("*.flac"))
check("3 FLAC outputs", len(outs) == 3, ", ".join(o.name for o in outs))
for o, freq in zip(outs, (440, 660, 880)):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(o), "-ac", "1", "-f", "s16le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(pcm, dtype=np.int16).astype(float)
    a = FLAC(str(o))
    dur = a.info.length
    spec = np.abs(np.fft.rfft(x))
    peak = np.fft.rfftfreq(len(x), 1 / a.info.sample_rate)[spec.argmax()]
    tags = {k: a.get(k, [None])[0] for k in ("title", "tracknumber", "replaygain_track_gain", "replaygain_album_gain")}
    # 40 s tone; tracks after the first also carry PRE_ROLL_S (0.8 s) of the gap before their onset
    check(f"{o.name}", -0.6 < dur - 40.0 < 0.6 + 0.8 and abs(peak - freq) < 3 and a.info.bits_per_sample == 16
          and tags["title"] and tags["replaygain_track_gain"] and tags["replaygain_album_gain"],
          f"{dur:.2f}s {peak:.0f}Hz {a.info.bits_per_sample}-bit title={tags['title']!r} "
          f"RG track={tags['replaygain_track_gain']} album={tags['replaygain_album_gain']} pictures={len(a.pictures)}")

# 12. hum: the verify file has only digital silence between tracks (nothing to find)
st, _, h0 = req("GET", f"/api/hum/{fid}")
check("hum: clean file -> not detected", st == 200 and h0.get("detected") is None, f"{h0}")

# 12b. a second 70 s file: 60 Hz hum (+ hiss) through the whole recording, tones as music
HUM_WAV = Path("/tmp/verify/hum.wav")
tt = np.arange(sr * 70) / sr
rng = np.random.default_rng(5)
hum = sum(10 ** (db / 20) * np.sin(2 * np.pi * 60 * k * tt + k) for k, db in
          enumerate((-45, -40, -42, -50, -48), start=1))
music = np.zeros_like(tt)
music[sr * 3:sr * 33] = 0.2 * np.sin(2 * np.pi * 440 * tt[sr * 3:sr * 33])
music[sr * 36:sr * 66] = 0.2 * np.sin(2 * np.pi * 660 * tt[sr * 36:sr * 66])
hum_sig = music + hum + rng.standard_normal(len(tt)) * 10 ** (-58 / 20)
with wave.open(str(HUM_WAV), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((np.clip(hum_sig, -1, 1) * 32767).astype("<i2").tobytes())
body, h = multipart(HUM_WAV)
st, _, up3 = req("POST", "/api/upload", body, h)
hid = up3["files"][0]["id"]
st, _, hd = req("GET", f"/api/hum/{hid}")
check("hum: 60 Hz injected into the silent stretches -> detected", st == 200 and hd.get("detected") == 60
      and hd.get("level_dbfs") is not None and -45 < hd["level_dbfs"] < -35 and len(hd.get("harmonics", [])) >= 3
      and hd.get("noise") and abs(hd["noise"]["floor_dbfs"] + 58) < 3,
      f"detected={hd.get('detected')} level={hd.get('level_dbfs')} dBFS harmonics={hd.get('harmonics')} "
      f"prominence={hd.get('prominence_db')} analysed={hd.get('analyzed_s')}s noise floor={(hd.get('noise') or {}).get('floor_dbfs')}")
t0 = time.time()
st, _, hd2 = req("GET", f"/api/hum/{hid}")
check("hum: cached", st == 200 and hd2 == hd and (time.time() - t0) < 0.5, f"{(time.time()-t0)*1000:.0f}ms")
st, _, _ = req("GET", f"/api/hum/{uuid.uuid4()}")
check("hum: unknown file -> 404", st == 404)

# 12c. A/B with hum + hiss on: the chain carries both, Removed holds the hum
st, _, ab2 = req("POST", "/api/restoration-test", {"file_id": hid, "start": 3.0, "end": 33.0, "rumble": False,
                 "declick": "off", "hum_filter": True, "hum_freq": 60, "hiss_reduction": "medium"})
okc = st == 200 and "bandreject=f=60" in ab2["chain"] and "afftdn=nr=12" in ab2["chain"] and ab2.get("removed_url")
check("hum+hiss A/B test", okc, str(ab2.get("chain", ab2))[:120] if isinstance(ab2, dict) else ab2)
if okc:
    s5, _, rem = req("GET", ab2["removed_url"], raw=True)
    check("hum+hiss A/B removed served", s5 == 200 and rem[:4] == b"fLaC", f"{len(rem)} bytes")

# 12d. process with hum removal + hiss reduction on: the hum file as a two-track side
st, _, pr2 = req("POST", "/api/process", {
    "file_id": hid, "release_id": 424242,
    "track_mapping": [{"detected": 1, "discogs": "A1"}, {"detected": 2, "discogs": "A2"}],
    "track_boundaries": [{"number": 1, "start": 3.0, "end": 33.0, "duration": 30.0},
                         {"number": 2, "start": 36.0, "end": 66.0, "duration": 30.0}],
    "output_format": "flac", "hum_filter": True, "hum_freq": 60, "hiss_reduction": "medium",
    "album_gain": False, "replaygain": False})
job2 = pr2.get("job_id") if isinstance(pr2, dict) else None
status2, js2 = None, {}
for _ in range(300):
    st, _, js2 = req("GET", f"/api/process/{job2}")
    status2 = js2.get("status") if isinstance(js2, dict) else None
    if status2 in ("complete", "completed", "failed", "error"):
        break
    time.sleep(0.5)
check("process job (hum + hiss on)", status2 in ("complete", "completed"), f"status={status2} {js2.get('error') or ''}")
outs2 = sorted(Path("/tmp/output").rglob("A[12]-*.flac"), key=lambda p: p.name)
src_x = (np.clip(hum_sig, -1, 1) * 32767).astype("<i2").astype(float) / 32768


def line(x, f, rate):
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w)) * 2 / np.sum(w)
    fr = np.fft.rfftfreq(len(x), 1 / rate)
    return float(np.sqrt(np.sum(spec[(fr > f - 1.5) & (fr < f + 1.5)] ** 2)))


def hiss_band(x, rate):
    spec = np.abs(np.fft.rfft(x)) ** 2
    fr = np.fft.rfftfreq(len(x), 1 / rate)
    return 10 * np.log10(spec[fr > 5000].sum() / len(x) ** 2 * 2)


for o, (a0, a1) in zip(outs2[-2:], ((3.0, 33.0), (36.0, 66.0))):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(o), "-ac", "1", "-f", "s16le", "-"], capture_output=True).stdout
    y = np.frombuffer(pcm, dtype=np.int16).astype(float) / 32768
    x = src_x[int(a0 * sr):int(a1 * sr)]
    n = min(len(x), len(y))
    cut = 20 * np.log10(line(x[:n], 60, sr) / max(line(y[:n], 60, sr), 1e-9))
    hiss = hiss_band(x[:n], sr) - hiss_band(y[:n], sr)
    check(f"{o.name} hum removed + hiss reduced", abs(len(y) - len(x)) <= 1 and cut >= 20 and 9 <= hiss <= 15,
          f"{len(y) / sr:.2f}s 60 Hz line -{cut:.0f} dB, hiss band -{hiss:.1f} dB (medium = 12)")
req("DELETE", f"/api/queue/{hid}")

print(f"\n{sum(results)}/{len(results)} checks passed")
