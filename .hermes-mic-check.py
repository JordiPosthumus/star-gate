"""Measure mic noise floor vs speech level to calibrate voice.silence_threshold."""
import time
import numpy as np
import sounddevice as sd

FS = 48000


def record(seconds, label):
    frames = []
    with sd.InputStream(samplerate=FS, channels=1, dtype="int16") as stream:
        n = int(FS * seconds)
        chunk = int(FS * 0.25)
        got = 0
        while got < n:
            data, _ = stream.read(min(chunk, n - got))
            frames.append(data.copy())
            got += len(data)
    audio = np.concatenate(frames)[:, 0].astype(np.float64)
    rms = np.sqrt(np.mean(audio**2))
    # per-250ms-window RMS to see the floor over time
    win = FS // 4
    windows = [np.sqrt(np.mean(audio[i:i+win]**2)) for i in range(0, len(audio) - win, win)]
    print(f"{label}: overall RMS={rms:.0f}  min_window={min(windows):.0f}  "
          f"max_window={max(windows):.0f}  median={sorted(windows)[len(windows)//2]:.0f}")
    print(f"  window trace: {[int(w) for w in windows]}")
    return rms


print("Settling 3s...")
time.sleep(3)
record(8, "SILENCE (8s)")
print("\aBeep — SPEAK NOW for 6 seconds", flush=True)
import subprocess
subprocess.run(["afplay", "/System/Library/Sounds/Ping.aiff"])
record(6, "SPEECH  (6s)")
print("\nIf SILENCE median is near or above 200 (the current threshold),")
print("auto-stop can never fire -> raise voice.silence_threshold above the")
print("silence median, e.g. silence_median*1.5 rounded up.")
