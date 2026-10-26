# Pulse Rhythm Check

A browser app that estimates how **regular** your pulse rhythm is, using only a phone's rear camera and a fingertip. It records about 45 seconds of video brightness, extracts a photoplethysmogram (PPG), detects heartbeats, computes standard heart-rate-variability metrics, and reports **Regular**, **Irregular — suggest clinical evaluation**, or **Insufficient signal quality — please retry**.

- **Live app:** https://arjunseg.github.io/pulse-rhythm-check/
- **Validation page:** https://arjunseg.github.io/pulse-rhythm-check/validate.html

> **Not a medical device.** This app does not diagnose any condition. It has not been validated against ECG. If you have symptoms or concerns about your heart rhythm, contact a clinician.

It is a **screening and educational** project built for the Congressional App Challenge. It uses **no machine learning**: every step is deterministic signal processing with explicit, documented thresholds.

---

## Project files

| File | What it does |
|---|---|
| `index.html` | The app: camera capture, live waveform, video-upload fallback, results screen. |
| `dsp.js` | All signal processing. Pure functions only: no DOM access, no browser APIs, no shared state. |
| `validate.html` | Validation harness: builds synthetic pulse signals with known beat times and runs them through the same `dsp.js` code. |
| `README.md` | This file. |

No npm, no build step, no frameworks, no external libraries or CDNs. All charts are drawn with plain `<canvas>`.

Both HTML pages import `dsp.js` and call the same `analyzeRecording()` function, so the validation page tests exactly the code the app runs on real camera data.

---

## How it works

1. **Capture.** The rear camera records at ~30 fps with the flash on, where the browser allows it. Each frame is shrunk to 160×120, and the red channel of the central 80×60 region is averaged and stored with the frame's real timestamp. White balance (and exposure, where supported) is locked after a 5-second settle period, so the camera doesn't adjust away the pulse.
2. **Resample.** The irregularly timed samples are linearly interpolated onto an even 30 Hz grid.
3. **Filter.** The signal is inverted (blood absorbs light, so brightness dips at each beat). Then a 1.5 s moving average is subtracted to remove drift, and a 5-sample moving average smooths noise. The effective pass band is about 0.3–2.7 Hz.
4. **Peak detection.** An adaptive threshold (0.5 × local RMS over 3 s) and a 300 ms refractory period find the beats. Parabolic interpolation then times each peak more precisely than one frame (33 ms).
5. **Inter-beat intervals.** Intervals outside 300–2000 ms, or more than 50% away from the median of their neighbours, are rejected and counted.
6. **Metrics.** Mean heart rate, RMSSD, pNN50, Shannon entropy of successive differences (16 bins, ±300 ms, normalised), and sample entropy (m = 2, r = 0.2 × SD). Sample entropy is marked low-confidence below 50 intervals.
7. **Quality gate.** This runs *before* any verdict. The recording fails if there are fewer than 20 valid intervals, more than 20% of intervals were rejected, beat heights vary too much (a sign of motion), or the camera's frame timing is unsteady.
8. **Classify.** Each metric is compared with a fixed threshold, and the rhythm is called "Irregular" if at least two metrics are flagged.

Every tunable number lives in one place: `DEFAULTS`, `QUALITY_LIMITS` and `THRESHOLDS` at the top of the relevant sections in `dsp.js`, and `CONFIG` in `index.html`.

### Thresholds are provisional

The classification thresholds in `THRESHOLDS` (`dsp.js`) are **placeholder values** chosen so the code runs. They are not taken from any publication. Each one is labelled **PROVISIONAL** in the code and the UI and shows `[THRESHOLD SOURCE — fill in citation]` until a published source is added.

To update one, edit its `value` and `source` (and set `provisional: false`) in `dsp.js`. The results screen picks up the change automatically.

### Validation scope

`validate.html` generates three synthetic 45-second recordings: **regular**, **irregular**, and **regular with a motion artifact**. For each, it reports detected vs true beat intervals, mean and maximum interval error, missed and spurious beats, metrics vs ground truth, and whether the quality gate passed or rejected the recording as expected. Add `?seed=N` to the URL to reproduce a specific run.

This validates the **signal-processing pipeline only**. It makes **no claim about clinical accuracy**, and the app reports no accuracy, sensitivity or specificity figures.

---

## Using the app

1. Open the live app on a phone: **Safari** on iPhone, **Chrome** on Android.
2. Tap **Start measurement** and allow camera access.
3. Lay the phone flat. Cover the **main rear lens** with your fingertip and let your finger lie toward the flash. Press lightly.
4. Hold still for about 50 seconds (5 s settle + 45 s recording).

**Fallback:** film a ~55-second fingertip video in the phone's Camera app with the flash on. Then, on the landing screen, open **"Or analyse a recorded video"** and choose the file. It runs through the identical pipeline.

The results screen shows the verdict, each quality check, each metric with its threshold, a beat-to-beat interval chart, the filtered signal with detected beats, and recording details. **Download raw data (CSV)** exports the per-frame values.

---

## Running locally

The pages use JavaScript modules, so they must be served over HTTP. **Opening the file directly (`file://`) will not work.**

```bash
cd "/path/to/this/folder"
python3 -m http.server 8765
```

Then open http://localhost:8765/index.html. A laptop webcam works on `localhost` for testing, but a phone camera needs **HTTPS**, so use the GitHub Pages deployment below.

---

## Publishing to GitHub Pages

Browsers only allow camera access on secure (HTTPS) pages, and GitHub Pages provides HTTPS for free.

### First-time setup

Requirements: [git](https://git-scm.com/) and the [GitHub CLI](https://cli.github.com/) (`gh`), logged in with `gh auth login`.

```bash
cd "/path/to/this/folder"
git init -b main
git add index.html dsp.js validate.html README.md .gitignore
git commit -m "Initial commit"
gh repo create pulse-rhythm-check --public --source=. --push
gh api -X POST repos/<your-username>/pulse-rhythm-check/pages -f "source[branch]=main" -f "source[path]=/"
```

The repository must be **public** for GitHub Pages on a free account. After 1–2 minutes, the site is live at:

```
https://<your-username>.github.io/pulse-rhythm-check/
```

You can check build status with:

```bash
gh api repos/<your-username>/pulse-rhythm-check/pages/builds/latest --jq .status
```

**Without the CLI:** create a public repository on github.com, upload the files, then go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, and select `main` / `/ (root)`.

### Publishing updates

```bash
git add -A
git commit -m "Describe the change"
git push
```

Pages rebuilds automatically, usually in under a minute. If a phone still shows the old version, close the tab and reopen it.

### `.gitignore`

`.claude/` holds local editor/preview settings and is excluded from the repository.

---

## Browser support and known limitations

- **Flash control** works in Chrome on Android and in recent iOS Safari. Where it's unavailable, the app suggests using a bright lamp and carries on.
- **Exposure lock** is not offered on iOS. White-balance lock is.
- On iPhones, the app prefers the single-lens **"Back Camera"** over virtual multi-lens cameras, which can switch lenses mid-recording.
- Beat timing at 30 fps carries roughly 10 ms of error. That inflates variability metrics on a regular rhythm (visible on the validation page), so thresholds must sit well above this floor.
- Sample entropy uses r = 0.2 × SD, so it measures unpredictability rather than the size of the variation.
- A 45-second recording at resting heart rates often yields fewer than 50 intervals, so sample entropy is frequently low-confidence and excluded from the verdict.
- Synthetic validation uses a simplified pulse shape and one kind of motion artifact. It has no breathing-related rhythm or amplitude changes.
- Some Android browsers cannot play iPhone HEVC (`.MOV`) videos in the upload fallback.
