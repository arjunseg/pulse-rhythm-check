// ============================================================================
// dsp.js: pure signal-processing functions for the pulse rhythm app.
//
// Rules for this file:
//   * No DOM access, no browser APIs, no mutable global state.
//   * Every function takes plain numbers/arrays and returns new values.
//   * index.html (live camera) and validate.html (synthetic test signals)
//     both call analyzeRecording() below, so the validation page tests the
//     EXACT code path used on real recordings.
//
// Units used throughout: time in milliseconds (ms), frequency in hertz (Hz),
// heart rate in beats per minute (bpm).
// ============================================================================

// ---------------------------------------------------------------------------
// Default parameters. These are DESIGN CHOICES for this app, not published
// clinical thresholds. Each one is explained where it is used.
// ---------------------------------------------------------------------------
export const DEFAULTS = Object.freeze({
  RESAMPLE_HZ: 30,                    // uniform analysis grid (camera runs at ~30 fps)
  DETREND_SECONDS: 1.5,               // baseline-removal window
  SMOOTH_SAMPLES: 5,                  // noise-smoothing window (5 samples = 167 ms at 30 Hz)
  PEAK_RMS_WINDOW_SECONDS: 3,         // window for the adaptive peak threshold
  PEAK_THRESHOLD_RMS_MULTIPLIER: 0.5, // a peak must exceed 0.5 x local RMS
  REFRACTORY_MS: 300,                 // two beats can't be closer than 300 ms (200 bpm)
  IBI_MIN_MS: 300,                    // plausible inter-beat interval range:
  IBI_MAX_MS: 2000,                   //   300 ms (200 bpm) to 2000 ms (30 bpm)
  IBI_NEIGHBOR_COUNT: 2,              // compare each interval to 2 neighbors on each side
  IBI_MAX_DEVIATION_FRACTION: 0.5,    // reject if >50% away from the neighbors' median
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Median of an array of numbers (does not modify the input).
export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Arithmetic mean.
export function mean(values) {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Centered moving average. Each output sample is the average of the input
// samples from (i - half) to (i + half). Near the ends of the signal the
// window shrinks to whatever samples exist, so the output has the same
// length as the input and no artificial zero-padding.
//
// windowSamples is rounded UP to an odd number so the window is symmetric
// around each sample (an even window can't be centered).
//
// Uses a running-sum ("prefix sum") so the cost is O(n) regardless of window.
function centeredMovingAverage(signal, windowSamples) {
  const n = signal.length;
  const half = Math.floor(windowSamples / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + signal[i];
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// STAGE 2: RESAMPLE
// ---------------------------------------------------------------------------

// resampleUniform(samples, targetHz)
//
// What: converts irregularly timed camera samples into evenly spaced samples.
// Why:  the camera does not deliver frames at exactly 30 fps; intervals jitter
//       by a few ms and frames are occasionally dropped. Every filter below
//       assumes "sample i+1 is exactly 1/30 s after sample i", so we first
//       rebuild the signal on a uniform time grid using straight-line
//       (linear) interpolation between the two real samples around each
//       grid point.
//
// Parameters:
//   samples  : array of { tMs, value }, tMs = frame time in milliseconds
//   targetHz : output sample rate in Hz (30 Hz -> one sample every 33.3 ms)
//
// Returns { timesMs, values, sampleRateHz, droppedSamples, maxGapMs }
//   droppedSamples : input frames ignored because their timestamp did not
//                    increase (duplicate frames) or was not a number
//   maxGapMs       : longest gap between real frames; long gaps mean the
//                    interpolation was guessing across missing data
export function resampleUniform(samples, targetHz) {
  // Keep only valid samples with strictly increasing timestamps.
  const clean = [];
  let droppedSamples = 0;
  for (const s of samples) {
    const valid = Number.isFinite(s.tMs) && Number.isFinite(s.value);
    const increasing = clean.length === 0 || s.tMs > clean[clean.length - 1].tMs;
    if (valid && increasing) {
      clean.push(s);
    } else {
      droppedSamples += 1;
    }
  }

  const result = { timesMs: [], values: [], sampleRateHz: targetHz, droppedSamples: droppedSamples, maxGapMs: 0 };
  if (clean.length < 2) return result;

  for (let i = 1; i < clean.length; i++) {
    const gap = clean[i].tMs - clean[i - 1].tMs;
    if (gap > result.maxGapMs) result.maxGapMs = gap;
  }

  const stepMs = 1000 / targetHz;
  const startMs = clean[0].tMs;
  const endMs = clean[clean.length - 1].tMs;
  const count = Math.floor((endMs - startMs) / stepMs) + 1;

  // Walk the grid and the input together. j is the index of the real sample
  // at or just before the current grid time.
  let j = 0;
  for (let k = 0; k < count; k++) {
    const t = startMs + k * stepMs;
    while (j < clean.length - 2 && clean[j + 1].tMs < t) {
      j += 1;
    }
    const a = clean[j];
    const b = clean[j + 1];
    const fraction = (t - a.tMs) / (b.tMs - a.tMs); // 0 at a, 1 at b
    result.timesMs.push(t);
    result.values.push(a.value + fraction * (b.value - a.value));
  }
  return result;
}

// ---------------------------------------------------------------------------
// STAGE 3: FILTER
// ---------------------------------------------------------------------------

// detrend(signal, windowSamples)
//
// What: subtracts a slow moving average from the signal.
// Why:  the raw brightness drifts slowly as finger pressure, skin temperature
//       and camera settings change ("baseline wander"). That drift is much
//       slower than a heartbeat. Subtracting a 1.5-second average removes it
//       and leaves the faster pulse wave centered around zero.
//       In filter terms this is a high-pass filter; with a 1.5 s window its
//       -3 dB point is roughly 0.3 Hz (18 bpm), well below any real heart rate.
//
// Parameters:
//   signal        : uniformly sampled values
//   windowSamples : averaging window in samples (1.5 s x 30 Hz = 45 samples)
export function detrend(signal, windowSamples) {
  const baseline = centeredMovingAverage(signal, windowSamples);
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    out[i] = signal[i] - baseline[i];
  }
  return out;
}

// smooth(signal, windowSamples)
//
// What: replaces each sample with the average of its neighbors.
// Why:  camera sensor noise changes randomly frame to frame; averaging a few
//       frames cancels much of it while keeping the slower pulse shape.
//       In filter terms this is a low-pass filter; a 5-sample window at
//       30 Hz has its -3 dB point near 2.7 Hz (160 bpm) and fully blocks
//       6 Hz. Combined with detrend() the pass band is roughly 0.3 to 2.7 Hz.
//
// Parameters:
//   signal        : uniformly sampled values
//   windowSamples : averaging window in samples (5 samples = 167 ms at 30 Hz)
export function smooth(signal, windowSamples) {
  return centeredMovingAverage(signal, windowSamples);
}

// ---------------------------------------------------------------------------
// STAGE 4: PEAK DETECTION
// ---------------------------------------------------------------------------

// detectPeaks(signal, sampleRateHz, options)
//
// What: finds the top of each pulse wave, i.e. one point per heartbeat.
// How:
//   1. Adaptive threshold. The pulse amplitude changes over a recording
//      (pressure, lighting), so a fixed threshold would fail. We compute the
//      local root-mean-square (RMS, a measure of typical signal size) over a
//      3-second window around each sample, and require a peak to exceed
//      0.5 x that local RMS.
//   2. Candidates are local maxima (higher than the sample before, at least
//      as high as the sample after) that clear the threshold.
//   3. Refractory period. A heart can't beat twice within 300 ms. Taking the
//      candidates from tallest to shortest, we accept a candidate only if no
//      already-accepted peak lies within 300 ms. Going tallest-first means the
//      main (systolic) peak wins over smaller bumps next to it.
//   4. Sub-sample timing. At 30 Hz the samples are 33.3 ms apart, so a raw
//      peak time is only accurate to +/-17 ms, which is as large as the
//      beat-to-beat changes we want to measure. We fit a parabola through the
//      peak sample and its two neighbors and use the parabola's vertex as the
//      peak time. This recovers timing between samples. (It can't add
//      information the camera didn't capture, but it removes the 33 ms
//      staircase effect.)
//
// Parameters:
//   signal        : filtered, zero-centered pulse signal, beats pointing UP
//   sampleRateHz  : sample rate of signal in Hz
//   options       : optional overrides of DEFAULTS
//                   (PEAK_RMS_WINDOW_SECONDS, PEAK_THRESHOLD_RMS_MULTIPLIER, REFRACTORY_MS)
//
// Returns { peaks, threshold }
//   peaks     : array of { index, timeMs, amplitude } sorted by time, where
//               timeMs is measured from the first sample of `signal`
//               (sub-sample precision) and amplitude is the parabola's height
//   threshold : the adaptive threshold at every sample (for plotting)
export function detectPeaks(signal, sampleRateHz, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const n = signal.length;
  const msPerSample = 1000 / sampleRateHz;

  // 1. Local RMS = sqrt(moving average of signal squared).
  const squared = new Float64Array(n);
  for (let i = 0; i < n; i++) squared[i] = signal[i] * signal[i];
  const rmsWindow = Math.max(1, Math.round(opts.PEAK_RMS_WINDOW_SECONDS * sampleRateHz));
  const meanSquare = centeredMovingAverage(squared, rmsWindow);
  const threshold = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    threshold[i] = opts.PEAK_THRESHOLD_RMS_MULTIPLIER * Math.sqrt(meanSquare[i]);
  }

  // 2. Candidate local maxima above threshold. (First and last samples are
  //    skipped because a parabola needs a neighbor on each side.)
  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    const isLocalMax = signal[i] > signal[i - 1] && signal[i] >= signal[i + 1];
    if (isLocalMax && signal[i] > threshold[i]) {
      candidates.push(i);
    }
  }

  // 3. Refractory period, tallest candidates first.
  const refractorySamples = opts.REFRACTORY_MS / msPerSample;
  const byHeight = candidates.slice().sort((a, b) => signal[b] - signal[a]);
  const accepted = [];
  for (const idx of byHeight) {
    let tooClose = false;
    for (const other of accepted) {
      if (Math.abs(idx - other) < refractorySamples) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(idx);
  }
  accepted.sort((a, b) => a - b);

  // 4. Parabolic interpolation around each accepted peak.
  //    With y0 = signal[i-1], y1 = signal[i], y2 = signal[i+1], the vertex of
  //    the parabola through these three points is offset from i by
  //        delta = 0.5 * (y0 - y2) / (y0 - 2*y1 + y2)      (between -0.5 and +0.5)
  //    and its height is
  //        y1 - 0.25 * (y0 - y2) * delta
  const peaks = [];
  for (const i of accepted) {
    const y0 = signal[i - 1];
    const y1 = signal[i];
    const y2 = signal[i + 1];
    const denominator = y0 - 2 * y1 + y2;
    let delta = 0;
    if (denominator !== 0) {
      delta = 0.5 * (y0 - y2) / denominator;
    }
    // Safety clamp: for a true local maximum delta is already within +/-0.5.
    if (delta > 0.5) delta = 0.5;
    if (delta < -0.5) delta = -0.5;
    peaks.push({
      index: i,
      timeMs: (i + delta) * msPerSample,
      amplitude: y1 - 0.25 * (y0 - y2) * delta,
    });
  }
  return { peaks: peaks, threshold: threshold };
}

// ---------------------------------------------------------------------------
// STAGE 5: INTER-BEAT INTERVALS
// ---------------------------------------------------------------------------

// peaksToIBIs(peakTimesMs)
//
// What: converts beat times into inter-beat intervals (IBIs): the time from
//       each beat to the next, in ms. N beats give N-1 intervals.
// Example: beats at [0, 850, 1690] ms -> IBIs [850, 840] ms.
export function peaksToIBIs(peakTimesMs) {
  const ibis = [];
  for (let i = 1; i < peakTimesMs.length; i++) {
    ibis.push(peakTimesMs[i] - peakTimesMs[i - 1]);
  }
  return ibis;
}

// filterIBIs(ibis, options)
//
// What: removes intervals that are almost certainly detection errors rather
//       than real heartbeats, and REPORTS how many were removed.
// Rules (applied in this order):
//   1. Range: outside [300, 2000] ms (i.e. faster than 200 bpm or slower
//      than 30 bpm) is physiologically implausible here -> reject.
//   2. Neighbor check: compare the interval with the median of up to 2
//      intervals before and 2 after it (only ones that passed rule 1).
//      If it differs from that median by more than 50% -> reject.
//      A missed beat makes one interval about twice as long (+100%); an
//      extra false beat splits one interval into two short ones. Both are
//      caught by this rule.
//
// IMPORTANT TRADE-OFF: a genuinely irregular rhythm also produces intervals
// that differ a lot from their neighbors. A strict neighbor rule can throw
// away real irregular beats. The 50% limit is deliberately loose for that
// reason, and the rejection COUNT is reported so it can't hide.
//
// Parameters:
//   ibis    : inter-beat intervals in ms
//   options : optional overrides (IBI_MIN_MS, IBI_MAX_MS, IBI_NEIGHBOR_COUNT,
//             IBI_MAX_DEVIATION_FRACTION)
//
// Returns {
//   kept            : the accepted intervals, in order
//   keptIndices     : position of each kept interval in the ORIGINAL list.
//                     Needed later: a successive difference is only valid
//                     between two intervals that were truly adjacent.
//   rejectedCount   : how many were rejected
//   rejectedIndices : positions of the rejected intervals
//   rejectedReasons : 'out of range' or 'differs from neighbors', per rejection
//   total           : number of intervals before filtering
// }
export function filterIBIs(ibis, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const n = ibis.length;

  // Rule 1: plausible range.
  const inRange = [];
  for (let i = 0; i < n; i++) {
    inRange.push(ibis[i] >= opts.IBI_MIN_MS && ibis[i] <= opts.IBI_MAX_MS);
  }

  const kept = [];
  const keptIndices = [];
  const rejectedIndices = [];
  const rejectedReasons = [];

  for (let i = 0; i < n; i++) {
    if (!inRange[i]) {
      rejectedIndices.push(i);
      rejectedReasons.push('out of range');
      continue;
    }

    // Rule 2: compare with the median of in-range neighbors.
    const neighbors = [];
    for (let j = i - opts.IBI_NEIGHBOR_COUNT; j <= i + opts.IBI_NEIGHBOR_COUNT; j++) {
      if (j === i || j < 0 || j >= n) continue;
      if (inRange[j]) neighbors.push(ibis[j]);
    }
    if (neighbors.length > 0) {
      const ref = median(neighbors);
      const deviation = Math.abs(ibis[i] - ref) / ref;
      if (deviation > opts.IBI_MAX_DEVIATION_FRACTION) {
        rejectedIndices.push(i);
        rejectedReasons.push('differs from neighbors');
        continue;
      }
    }

    kept.push(ibis[i]);
    keptIndices.push(i);
  }

  return {
    kept: kept,
    keptIndices: keptIndices,
    rejectedCount: rejectedIndices.length,
    rejectedIndices: rejectedIndices,
    rejectedReasons: rejectedReasons,
    total: n,
  };
}

// ---------------------------------------------------------------------------
// STAGE 6: METRICS
// ---------------------------------------------------------------------------

// meanHeartRateBpm(ibis)
//
// meanHR = 60000 / mean(IBI)
// 60000 is the number of milliseconds in a minute, so an average interval of
// 857 ms gives 60000 / 857 = 70 beats per minute.
export function meanHeartRateBpm(ibis) {
  if (ibis.length === 0) return NaN;
  return 60000 / mean(ibis);
}

// Sample standard deviation (divides by n - 1).
export function standardDeviation(values) {
  if (values.length < 2) return NaN;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) * (v - m);
  return Math.sqrt(sumSq / (values.length - 1));
}

// successiveDifferences(ibis, originalIndices)
//
// What: the change from each interval to the next: d[k] = IBI[k+1] - IBI[k], in ms.
// Why the second parameter: if an interval was rejected by filterIBIs, the
// intervals on either side of the gap were NOT consecutive heartbeats.
// Subtracting them would invent a jump that never happened. So we only take
// a difference when the two intervals were neighbors in the original series.
//   originalIndices : keptIndices from filterIBIs. If omitted, every pair of
//                     neighbors is used (fine for an unfiltered series).
export function successiveDifferences(ibis, originalIndices) {
  const diffs = [];
  for (let k = 0; k + 1 < ibis.length; k++) {
    const adjacent = !originalIndices || originalIndices[k + 1] === originalIndices[k] + 1;
    if (adjacent) diffs.push(ibis[k + 1] - ibis[k]);
  }
  return diffs;
}

// rmssd(diffs)
//
// Root Mean Square of Successive Differences, in ms:
//   RMSSD = sqrt( mean( d[k]^2 ) )
// Squares each beat-to-beat change, averages them, takes the square root.
// A steady rhythm gives small values; an erratic one gives large values.
export function rmssd(diffs) {
  if (diffs.length === 0) return NaN;
  let sumSq = 0;
  for (const d of diffs) sumSq += d * d;
  return Math.sqrt(sumSq / diffs.length);
}

// pnn50(diffs)
//
// Percentage of successive differences larger than 50 ms (in either direction):
//   pNN50 = 100 x (number of |d[k]| > 50 ms) / (number of differences)
export function pnn50(diffs) {
  if (diffs.length === 0) return NaN;
  let count = 0;
  for (const d of diffs) {
    if (Math.abs(d) > 50) count += 1;
  }
  return (100 * count) / diffs.length;
}

// shannonEntropyOfDiffs(diffs, binCount, rangeMs)
//
// What: how spread out the beat-to-beat changes are, on a 0..1 scale.
// How:
//   1. Make a histogram of the differences with 16 equal bins covering
//      -300 ms to +300 ms (each bin is 37.5 ms wide).
//      Differences beyond +/-300 ms are counted in the outermost bin
//      (a design choice: dropping them would hide the most irregular beats).
//   2. Turn counts into proportions p (they add up to 1).
//   3. Shannon entropy H = -sum( p x ln(p) ), skipping empty bins.
//   4. Divide by ln(16), the largest possible value, so the result is 0..1.
// Interpretation: 0 = every difference fell in the same bin (very steady);
// 1 = differences spread evenly over all bins (very erratic).
// Unlike sample entropy, this uses FIXED bin widths in ms, so it responds
// to how BIG the changes are, not only how unpredictable they are.
export function shannonEntropyOfDiffs(diffs, binCount, rangeMs) {
  const bins = binCount || 16;
  const range = rangeMs || 300;
  if (diffs.length === 0) return NaN;
  const counts = new Array(bins).fill(0);
  const binWidth = (2 * range) / bins;
  for (const d of diffs) {
    let b = Math.floor((d + range) / binWidth);
    if (b < 0) b = 0;
    if (b > bins - 1) b = bins - 1;
    counts[b] += 1;
  }
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / diffs.length;
    h -= p * Math.log(p);
  }
  return h / Math.log(bins);
}

// sampleEntropy(series, m, rFraction)
//
// What: how UNPREDICTABLE the interval series is (Richman & Moorman's
//       sample entropy, "SampEn").
// How, in plain words:
//   * Take every run of m = 2 consecutive intervals (a "template").
//   * Count pairs of templates that match: every element within r of the
//     other, where r = 0.2 x the standard deviation of the series. Call the
//     number of matching pairs B.
//   * Do the same for runs of m + 1 = 3 intervals. Call that A.
//   * SampEn = -ln(A / B).
//   If patterns that match for 2 beats usually still match for a 3rd beat,
//   A is close to B and SampEn is low (predictable). If they usually
//   diverge, SampEn is high (unpredictable).
// Details:
//   * A template is never compared with itself.
//   * Both counts use the same N - m starting positions, so A and B are
//     comparable (standard practice).
//   * If A or B is zero, SampEn is undefined and null is returned.
// IMPORTANT: because r is 0.2 x SD, SampEn ignores how LARGE the variation
//   is: tiny random jitter and huge random variation give similar values.
//   It measures predictability, not size.
// Reliability: with few intervals, A and B are small counts and SampEn
//   jumps around. computeMetrics() flags it as low-confidence below 50.
export function sampleEntropy(series, m, rFraction) {
  const n = series.length;
  const sd = standardDeviation(series);
  if (n < m + 2 || !(sd > 0)) return null;
  const r = rFraction * sd;

  let matchesM = 0;       // B
  let matchesMPlus1 = 0;  // A
  const starts = n - m;   // same starting positions for both template lengths
  for (let i = 0; i < starts; i++) {
    for (let j = i + 1; j < starts; j++) {
      // Do the first m elements match (Chebyshev distance <= r)?
      let match = true;
      for (let k = 0; k < m; k++) {
        if (Math.abs(series[i + k] - series[j + k]) > r) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      matchesM += 1;
      // Does the match extend to element m (length m + 1)?
      if (Math.abs(series[i + m] - series[j + m]) <= r) {
        matchesMPlus1 += 1;
      }
    }
  }
  if (matchesM === 0 || matchesMPlus1 === 0) return null;
  return -Math.log(matchesMPlus1 / matchesM);
}

// Below this many intervals, sample entropy is reported as low-confidence.
export const SAMPLE_ENTROPY_MIN_INTERVALS = 50;

// computeMetrics(ibis, originalIndices)
//
// Computes every rhythm metric from the ACCEPTED intervals.
//   ibis            : accepted inter-beat intervals in ms (filterIBIs().kept)
//   originalIndices : filterIBIs().keptIndices, so successive differences
//                     are never taken across a rejected interval
//
// Returns {
//   meanHR          : bpm
//   rmssd           : ms
//   pnn50           : percent (0..100)
//   shannonEntropy  : 0..1
//   sampleEntropy   : unitless, or null if undefined
//   sampleEntropyLowConfidence : true if fewer than 50 intervals
//   beatCount       : number of accepted inter-beat intervals
//   diffCount       : number of successive differences used
// }
export function computeMetrics(ibis, originalIndices) {
  const diffs = successiveDifferences(ibis, originalIndices);
  return {
    meanHR: meanHeartRateBpm(ibis),
    rmssd: rmssd(diffs),
    pnn50: pnn50(diffs),
    shannonEntropy: shannonEntropyOfDiffs(diffs, 16, 300),
    sampleEntropy: sampleEntropy(ibis, 2, 0.2),
    sampleEntropyLowConfidence: ibis.length < SAMPLE_ENTROPY_MIN_INTERVALS,
    beatCount: ibis.length,
    diffCount: diffs.length,
  };
}

// ---------------------------------------------------------------------------
// STAGE 7: QUALITY GATE
// ---------------------------------------------------------------------------

// Quality limits. A recording failing ANY of these gets no rhythm verdict.
//   MIN_VALID_INTERVALS and MAX_REJECTED_FRACTION come from the project's
//   design spec. The others are PROVISIONAL developer choices (round numbers,
//   not from a paper) and are labelled that way in the UI.
export const QUALITY_LIMITS = Object.freeze({
  MIN_VALID_INTERVALS: 20,            // design spec: need at least 20 accepted intervals
  MAX_REJECTED_FRACTION: 0.20,        // design spec: at most 20% of intervals rejected
  MAX_AMPLITUDE_CV: 0.5,              // PROVISIONAL: beat heights may vary by at most 50% (CV)
  MAX_MEDIAN_FRAME_INTERVAL_MS: 50,   // PROVISIONAL: camera must deliver >= 20 fps
  MAX_FRAME_INTERVAL_IQR_MS: 15,      // PROVISIONAL: frame-timing spread (IQR) at most 15 ms
  MAX_FRAME_GAP_MS: 500,              // PROVISIONAL: no single gap between frames over 0.5 s
});

// Percentile by sorting and picking the nearest rank (q between 0 and 1).
function percentile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.round(q * (sorted.length - 1))];
}

// frameTimingStats(frameTimesMs)
//
// Summarizes how evenly the camera delivered frames.
//   medianMs : typical time between frames (33.3 ms = 30 fps)
//   iqrMs    : interquartile range of the intervals, i.e. the spread of the
//              middle 50% (small = steady timing)
//   maxGapMs : the single longest pause between frames
export function frameTimingStats(frameTimesMs) {
  const intervals = [];
  for (let i = 1; i < frameTimesMs.length; i++) {
    intervals.push(frameTimesMs[i] - frameTimesMs[i - 1]);
  }
  return {
    medianMs: median(intervals),
    iqrMs: percentile(intervals, 0.75) - percentile(intervals, 0.25),
    maxGapMs: intervals.length ? Math.max(...intervals) : NaN,
    frameCount: frameTimesMs.length,
  };
}

// Pearson correlation of two equal-length arrays (-1..1).
function correlation(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) * (a[i] - ma);
    db += (b[i] - mb) * (b[i] - mb);
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

// beatShapeSQI(signal, peaks, sampleRateHz, medianIbiMs)
//
// Signal quality index (SQI), 0..1: how similar each beat's SHAPE is to the
// average beat.
// How:
//   1. Cut a window around every detected peak, from 30% of a typical
//      interval before the peak to 50% after it.
//   2. Average all windows into a template ("the typical beat").
//   3. Correlate each beat with the template (1 = identical shape).
//   4. SQI = average correlation.
// Why: motion artifacts produce bumps that don't look like a pulse wave, so
// they lower the SQI. Correlation ignores beat HEIGHT, so an irregular rhythm
// whose beats differ in size but keep their shape is not penalized.
// The window fractions (30% / 50%) are a design choice.
export function beatShapeSQI(signal, peaks, sampleRateHz, medianIbiMs) {
  if (peaks.length < 3 || !Number.isFinite(medianIbiMs)) return NaN;
  const samplesPerMs = sampleRateHz / 1000;
  const before = Math.round(0.3 * medianIbiMs * samplesPerMs);
  const after = Math.round(0.5 * medianIbiMs * samplesPerMs);
  const windows = [];
  for (const p of peaks) {
    if (p.index - before < 0 || p.index + after >= signal.length) continue;
    const w = [];
    for (let i = p.index - before; i <= p.index + after; i++) w.push(signal[i]);
    windows.push(w);
  }
  if (windows.length < 3) return NaN;
  const template = new Array(windows[0].length).fill(0);
  for (const w of windows) {
    for (let i = 0; i < w.length; i++) template[i] += w[i] / windows.length;
  }
  let total = 0;
  for (const w of windows) total += correlation(w, template);
  return total / windows.length;
}

// assessQuality(signal, peaks, ibiResult, frameTimings, options)
//
// What: decides whether a recording is trustworthy enough to classify.
// Why:  hand or finger movement creates big, irregular bumps that look
//       almost exactly like an irregular heart rhythm. Without this gate a
//       shaky recording would be reported as "Irregular". So we check the
//       recording BEFORE any verdict, and refuse to give one if it fails.
//
// Checks (each produces a readable reason when it fails):
//   1. Enough beats:   at least 20 accepted intervals
//   2. Few rejections: at most 20% of intervals rejected by filterIBIs
//   3. Steady beat height: coefficient of variation (CV = SD / mean) of the
//      detected peak amplitudes at most 0.5. Motion makes some "beats"
//      many times taller than others.
//   4. Steady camera: median frame interval <= 50 ms, interframe IQR
//      <= 15 ms, and no gap over 500 ms.
//
// Parameters:
//   signal       : filtered pulse signal (beats pointing up)
//   peaks        : detectPeaks().peaks
//   ibiResult    : filterIBIs() result
//   frameTimings : the RAW frame timestamps in ms (before resampling)
//   options      : { sampleRateHz } of `signal`, needed for the SQI
//
// Returns {
//   pass        : true if every check passed
//   reasons     : readable failure reasons (empty when pass is true)
//   sqi         : beat-shape signal quality index, 0..1 (reported, not gated)
//   checks      : every check with its value, limit and result (for the UI)
//   frameStats  : frameTimingStats() output
//   amplitudeCV : the beat-height CV
// }
export function assessQuality(signal, peaks, ibiResult, frameTimings, options) {
  const L = QUALITY_LIMITS;
  const sampleRateHz = (options && options.sampleRateHz) || DEFAULTS.RESAMPLE_HZ;
  const checks = [];
  const add = (name, value, limitText, pass, failText) => {
    checks.push({ name: name, value: value, limitText: limitText, pass: pass, failText: failText });
  };

  // 1. Enough valid intervals.
  const valid = ibiResult.kept.length;
  add('Valid beat intervals', valid, '≥ ' + L.MIN_VALID_INTERVALS,
      valid >= L.MIN_VALID_INTERVALS,
      'Only ' + valid + ' valid beat intervals (need at least ' + L.MIN_VALID_INTERVALS + ').');

  // 2. Rejection rate.
  const rejectedFraction = ibiResult.total > 0 ? ibiResult.rejectedCount / ibiResult.total : 1;
  add('Intervals rejected', rejectedFraction, '≤ ' + Math.round(L.MAX_REJECTED_FRACTION * 100) + '%',
      rejectedFraction <= L.MAX_REJECTED_FRACTION,
      Math.round(rejectedFraction * 100) + '% of beat intervals were implausible (limit ' +
      Math.round(L.MAX_REJECTED_FRACTION * 100) + '%). Likely movement or poor finger contact.');

  // 3. Beat height consistency (motion artifact).
  const amplitudes = peaks.map((p) => p.amplitude);
  const amplitudeCV = amplitudes.length >= 2 ? standardDeviation(amplitudes) / mean(amplitudes) : NaN;
  add('Beat height variation (CV)', amplitudeCV, '≤ ' + L.MAX_AMPLITUDE_CV + ' (PROVISIONAL)',
      Number.isFinite(amplitudeCV) && amplitudeCV <= L.MAX_AMPLITUDE_CV,
      'Beat heights varied too much (CV ' + (Number.isFinite(amplitudeCV) ? amplitudeCV.toFixed(2) : 'n/a') +
      '). This usually means the finger or phone moved.');

  // 4. Camera frame timing.
  const frameStats = frameTimingStats(frameTimings);
  add('Median frame interval', frameStats.medianMs, '≤ ' + L.MAX_MEDIAN_FRAME_INTERVAL_MS + ' ms (PROVISIONAL)',
      frameStats.medianMs <= L.MAX_MEDIAN_FRAME_INTERVAL_MS,
      'Camera frame rate too low (median ' + frameStats.medianMs.toFixed(1) + ' ms between frames).');
  add('Frame interval IQR', frameStats.iqrMs, '≤ ' + L.MAX_FRAME_INTERVAL_IQR_MS + ' ms (PROVISIONAL)',
      frameStats.iqrMs <= L.MAX_FRAME_INTERVAL_IQR_MS,
      'Camera frame timing too uneven (IQR ' + frameStats.iqrMs.toFixed(1) + ' ms).');
  add('Longest frame gap', frameStats.maxGapMs, '≤ ' + L.MAX_FRAME_GAP_MS + ' ms (PROVISIONAL)',
      frameStats.maxGapMs <= L.MAX_FRAME_GAP_MS,
      'The camera paused for ' + Math.round(frameStats.maxGapMs) + ' ms during recording.');

  const reasons = [];
  for (const c of checks) {
    if (!c.pass) reasons.push(c.failText);
  }

  const sqi = beatShapeSQI(signal, peaks, sampleRateHz, median(ibiResult.kept));

  return {
    pass: reasons.length === 0,
    reasons: reasons,
    sqi: sqi,
    checks: checks,
    frameStats: frameStats,
    amplitudeCV: amplitudeCV,
  };
}

// ---------------------------------------------------------------------------
// STAGE 8: CLASSIFY
// ---------------------------------------------------------------------------

// Decision thresholds.
//
// *** EVERY VALUE BELOW IS PROVISIONAL. ***
// They are round placeholder numbers chosen by the developer so the code
// runs. They are NOT taken from any paper. Each must be replaced with a
// value from a published source, and the source written into `source`
// (shown in the UI next to the threshold).
export const THRESHOLDS = Object.freeze({
  rmssd: Object.freeze({
    label: 'RMSSD',
    unit: 'ms',
    value: 100,            // PROVISIONAL placeholder
    direction: 'above',    // flagged when the metric is ABOVE value
    provisional: true,
    source: '[THRESHOLD SOURCE — fill in citation]',
  }),
  pnn50: Object.freeze({
    label: 'pNN50',
    unit: '%',
    value: 50,             // PROVISIONAL placeholder
    direction: 'above',
    provisional: true,
    source: '[THRESHOLD SOURCE — fill in citation]',
  }),
  shannonEntropy: Object.freeze({
    label: 'Shannon entropy (ΔIBI)',
    unit: '',
    value: 0.7,            // PROVISIONAL placeholder
    direction: 'above',
    provisional: true,
    source: '[THRESHOLD SOURCE — fill in citation]',
  }),
  sampleEntropy: Object.freeze({
    label: 'Sample entropy',
    unit: '',
    value: 1.5,            // PROVISIONAL placeholder
    direction: 'above',
    provisional: true,
    source: '[THRESHOLD SOURCE — fill in citation]',
  }),
});

// How many metric flags are needed to call the rhythm irregular.
// PROVISIONAL design choice (not from a paper): requiring agreement between
// at least 2 metrics means one noisy metric can't produce "Irregular" alone.
export const FLAGS_NEEDED_FOR_IRREGULAR = 2;

export const VERDICTS = Object.freeze({
  REGULAR: 'Regular',
  IRREGULAR: 'Irregular — suggest clinical evaluation',
  INSUFFICIENT: 'Insufficient signal quality — please retry',
});

// classify(metrics, quality)
//
// What: turns the metrics into one of three verdicts using fixed thresholds.
// Steps:
//   1. If the quality gate failed, stop: verdict is "Insufficient signal
//      quality". A noisy recording must never be labelled regular or irregular.
//   2. Compare each rhythm metric with its threshold and record a flag.
//      Sample entropy only VOTES when it is high-confidence (>= 50 intervals)
//      and defined; otherwise it is shown but excluded from the vote.
//   3. If at least FLAGS_NEEDED_FOR_IRREGULAR voting metrics are flagged,
//      the verdict is "Irregular"; otherwise "Regular".
//
// Parameters:
//   metrics : output of computeMetrics()
//   quality : output of assessQuality(), or null if not assessed
//
// Returns {
//   verdict        : one of VERDICTS
//   perMetricFlags : { key: { value, threshold, flagged, votes, note } }
//   flagCount      : number of voting metrics flagged
//   votingCount    : number of metrics that voted
// }
export function classify(metrics, quality) {
  const perMetricFlags = {};
  let flagCount = 0;
  let votingCount = 0;

  for (const key of Object.keys(THRESHOLDS)) {
    const t = THRESHOLDS[key];
    const value = metrics[key];
    const defined = value !== null && Number.isFinite(value);
    const flagged = defined && (t.direction === 'above' ? value > t.value : value < t.value);

    let votes = defined;
    let note = '';
    if (!defined) {
      note = 'could not be computed';
    } else if (key === 'sampleEntropy' && metrics.sampleEntropyLowConfidence) {
      votes = false;
      note = 'low confidence (fewer than ' + SAMPLE_ENTROPY_MIN_INTERVALS + ' intervals): not used in verdict';
    }

    if (votes) {
      votingCount += 1;
      if (flagged) flagCount += 1;
    }
    perMetricFlags[key] = { value: value, threshold: t, flagged: flagged, votes: votes, note: note };
  }

  let verdict;
  if (quality && quality.pass === false) {
    verdict = VERDICTS.INSUFFICIENT;
  } else if (votingCount < FLAGS_NEEDED_FOR_IRREGULAR) {
    verdict = VERDICTS.INSUFFICIENT; // not enough usable metrics to decide
  } else if (flagCount >= FLAGS_NEEDED_FOR_IRREGULAR) {
    verdict = VERDICTS.IRREGULAR;
  } else {
    verdict = VERDICTS.REGULAR;
  }

  return { verdict: verdict, perMetricFlags: perMetricFlags, flagCount: flagCount, votingCount: votingCount };
}

// ---------------------------------------------------------------------------
// FULL PIPELINE
// ---------------------------------------------------------------------------

// analyzeRecording(samples, options)
//
// Runs every stage in order. Both index.html and validate.html call this one
// function, so the validation page exercises exactly the same steps.
//
// Parameters:
//   samples : array of { tMs, value }, raw red-channel brightness per frame,
//             in CAMERA convention (brightness DIPS at each heartbeat,
//             because blood absorbs light)
//   options : optional overrides of DEFAULTS
//
// Returns every intermediate result so the UI can plot each stage.
export function analyzeRecording(samples, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});

  // Stage 2: uniform grid.
  const resampled = resampleUniform(samples, opts.RESAMPLE_HZ);
  const fs = resampled.sampleRateHz;
  const startMs = resampled.timesMs.length > 0 ? resampled.timesMs[0] : 0;

  // Invert so that heartbeats point UP. More blood -> less light reaches the
  // camera -> brightness dips at each beat. Peak detection looks for maxima.
  const inverted = resampled.values.map((v) => -v);

  // Stage 3: remove baseline drift, then smooth sensor noise.
  const detrended = detrend(inverted, Math.round(opts.DETREND_SECONDS * fs));
  const filtered = smooth(detrended, opts.SMOOTH_SAMPLES);

  // Stage 4: beats. Peak times are converted back to recording time.
  const peakResult = detectPeaks(filtered, fs, opts);
  const peakTimesMs = peakResult.peaks.map((p) => p.timeMs + startMs);

  // Stage 5: intervals, with implausible ones rejected and counted.
  const ibis = peaksToIBIs(peakTimesMs);
  const ibiResult = filterIBIs(ibis, opts);

  // Stage 6: metrics from accepted intervals only.
  const metrics = computeMetrics(ibiResult.kept, ibiResult.keptIndices);
  const meanHR = metrics.meanHR;

  // Stage 7: quality gate, BEFORE any verdict. Frame timing is judged on the
  // raw camera timestamps, not the resampled grid.
  const frameTimings = samples.map((s) => s.tMs);
  const quality = assessQuality(filtered, peakResult.peaks, ibiResult, frameTimings, { sampleRateHz: fs });

  // Stage 8: verdict (forced to "Insufficient" if the quality gate failed).
  const classification = classify(metrics, quality);

  // Time of each accepted interval (its ending beat), for the tachogram chart.
  const keptIbiTimesMs = ibiResult.keptIndices.map((i) => peakTimesMs[i + 1]);

  return {
    metrics: metrics,
    quality: quality,
    classification: classification,
    keptIbiTimesMs: keptIbiTimesMs,
    resampled: resampled,
    filtered: filtered,
    threshold: peakResult.threshold,
    peaks: peakResult.peaks,
    peakTimesMs: peakTimesMs,
    ibis: ibis,
    ibiResult: ibiResult,
    meanHR: meanHR,
  };
}
