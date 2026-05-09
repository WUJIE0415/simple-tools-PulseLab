export type RouteRole = "primary" | "support" | "suspect" | "disabled";

export type AlgorithmRouteKey =
  | "rhythm2013_multifeature"
  | "rhythm2013_degara"
  | "percival"
  | "ejs_full"
  | "ejs_middle"
  | "ejs_best_segment"
  | "groove_full"
  | "groove_middle"
  | "groove_bass"
  | "groove_high_mid";

export interface AlgorithmRoute {
  role: RouteRole;
  weightMultiplier: number;
  reasons: string[];
}

export interface RouteProfile {
  sampleRate: number;
  onsetRegularity: number;
  tempoStability: number;
  bassEnergyRatio: number;
  lowBandRegularity: number;
  midHighRegularity: number;
  crossBandAgreement: number;
}

export interface AnalysisWindowCandidate {
  label: string;
  startSeconds: number;
  durationSeconds: number;
  energyScore: number;
  onsetScore: number;
  onsetRegularity: number;
  tempoStability: number;
  crossBandAgreement: number;
}

export interface RankedAnalysisWindow extends AnalysisWindowCandidate {
  quality: number;
  role: RouteRole;
  weightMultiplier: number;
}

export interface BpmPreAnalysis {
  profile: RouteProfile;
  routes: Record<AlgorithmRouteKey, AlgorithmRoute>;
  windows: RankedAnalysisWindow[];
  segmentWeights: Record<string, number>;
}

const TARGET_SEGMENT_SECONDS = 30;
const WINDOW_SCAN_STEP_SECONDS = 5;
const ENVELOPE_RATE = 50;
const MIN_ANALYSIS_BPM = 50;
const MAX_ANALYSIS_BPM = 220;

function clamp(value: number, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function route(role: RouteRole, weightMultiplier: number, reasons: string[]): AlgorithmRoute {
  return {
    role,
    weightMultiplier: Math.round(clamp(weightMultiplier, 0, 3.5) * 100) / 100,
    reasons
  };
}

function roleForQuality(quality: number): RouteRole {
  if (quality >= 0.72) return "primary";
  if (quality >= 0.48) return "support";
  if (quality >= 0.18) return "suspect";
  return "disabled";
}

export function rankAnalysisWindows(windows: AnalysisWindowCandidate[]): RankedAnalysisWindow[] {
  return windows
    .map((window) => {
      const quality =
        window.onsetRegularity * 0.38 +
        window.tempoStability * 0.3 +
        window.crossBandAgreement * 0.22 +
        window.onsetScore * 0.06 +
        window.energyScore * 0.04;

      return {
        ...window,
        quality: Math.round(clamp(quality) * 1000) / 1000,
        role: roleForQuality(quality),
        weightMultiplier: Math.round((0.35 + clamp(quality) * 1.15) * 100) / 100
      };
    })
    .sort((a, b) => b.quality - a.quality || b.onsetRegularity - a.onsetRegularity || a.startSeconds - b.startSeconds);
}

export function classifyAlgorithmRoutes(profile: RouteProfile): Record<AlgorithmRouteKey, AlgorithmRoute> {
  const sampleRateOk = Math.abs(profile.sampleRate - 44100) < 1;
  const beatEvidence = (profile.onsetRegularity + profile.tempoStability + profile.midHighRegularity) / 3;
  const bassTrusted =
    profile.bassEnergyRatio >= 0.16 && profile.lowBandRegularity >= 0.5 && profile.crossBandAgreement >= 0.45;
  const bassStrong =
    profile.bassEnergyRatio >= 0.3 && profile.lowBandRegularity >= 0.7 && profile.crossBandAgreement >= 0.62;
  const highMidTrusted = profile.midHighRegularity >= 0.55 && profile.crossBandAgreement >= 0.4;
  const multifeatureQuality = sampleRateOk ? beatEvidence : beatEvidence * 0.65;
  const degaraQuality = (profile.onsetRegularity * 0.5 + profile.tempoStability * 0.35 + profile.midHighRegularity * 0.15);
  const percivalQuality = profile.tempoStability * 0.58 + profile.onsetRegularity * 0.28 + profile.crossBandAgreement * 0.14;

  return {
    rhythm2013_multifeature: route(roleForQuality(multifeatureQuality), 0.65 + multifeatureQuality * 0.9, [
      sampleRateOk ? "sample-rate-ok" : "sample-rate-not-44100",
      "multi-feature-beat-evidence"
    ]),
    rhythm2013_degara: route(roleForQuality(degaraQuality), 0.55 + degaraQuality * 1.05, [
      "transient-grid-evidence",
      "confidence-unavailable"
    ]),
    percival: route(roleForQuality(percivalQuality), 0.45 + percivalQuality * 0.8, ["periodicity-evidence"]),
    ejs_full: route(roleForQuality(multifeatureQuality), 0.75 + multifeatureQuality * 0.55, ["whole-track-context"]),
    ejs_middle: route(roleForQuality(beatEvidence), 0.8 + beatEvidence * 0.6, ["middle-section-context"]),
    ejs_best_segment: route(roleForQuality(Math.max(beatEvidence, degaraQuality)), 0.85 + Math.max(beatEvidence, degaraQuality) * 0.75, [
      "best-rhythm-window"
    ]),
    groove_full: route(roleForQuality(beatEvidence * 0.85 + profile.crossBandAgreement * 0.15), 0.55 + beatEvidence * 0.65, [
      "full-mix-web-detector"
    ]),
    groove_middle: route(roleForQuality(beatEvidence * 0.9 + profile.crossBandAgreement * 0.1), 0.6 + beatEvidence * 0.65, [
      "middle-web-detector"
    ]),
    groove_bass: bassTrusted
      ? route(bassStrong ? "primary" : "support", bassStrong ? 1.25 : 0.85, ["low-band-regular", "cross-band-agreement"])
      : route(profile.bassEnergyRatio < 0.08 ? "disabled" : "suspect", profile.bassEnergyRatio < 0.08 ? 0.05 : 0.25, [
          "low-band-not-self-authorizing"
        ]),
    groove_high_mid: highMidTrusted
      ? route(roleForQuality((profile.midHighRegularity + profile.crossBandAgreement) / 2), 0.55 + profile.midHighRegularity * 0.65, [
          "mid-high-transients"
        ])
      : route("suspect", 0.35, ["mid-high-weak-or-isolated"])
  };
}

function createEnvelope(audioBuffer: AudioBuffer, startSeconds: number, durationSeconds: number) {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(startSeconds * sampleRate);
  const frameCount = Math.max(0, Math.min(audioBuffer.length - startFrame, Math.floor(durationSeconds * sampleRate)));
  const hopSize = Math.max(1, Math.floor(sampleRate / ENVELOPE_RATE));
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
  const envelope: number[] = [];

  for (let frameStart = 0; frameStart < frameCount; frameStart += hopSize) {
    let energy = 0;
    let samples = 0;
    const frameEnd = Math.min(frameCount, frameStart + hopSize);

    for (let index = frameStart; index < frameEnd; index += 1) {
      let sample = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        sample += audioBuffer.getChannelData(channel)[startFrame + index] / channelCount;
      }
      energy += sample * sample;
      samples += 1;
    }

    envelope.push(samples > 0 ? Math.sqrt(energy / samples) : 0);
  }

  return envelope;
}

function getEnvelopeStats(envelope: number[]) {
  if (envelope.length === 0) {
    return {
      energyScore: 0,
      onsetScore: 0,
      onsetRegularity: 0,
      tempoStability: 0,
      crossBandAgreement: 0
    };
  }

  const mean = envelope.reduce((sum, value) => sum + value, 0) / envelope.length;
  const variance = envelope.reduce((sum, value) => sum + (value - mean) ** 2, 0) / envelope.length;
  const deviation = Math.sqrt(variance);
  const onsetFlux = envelope.map((value, index) => Math.max(0, value - (envelope[index - 1] ?? value)));
  const onsetMean = onsetFlux.reduce((sum, value) => sum + value, 0) / onsetFlux.length;
  const onsetDeviation = Math.sqrt(onsetFlux.reduce((sum, value) => sum + (value - onsetMean) ** 2, 0) / onsetFlux.length);
  const threshold = onsetMean + onsetDeviation * 0.75;
  const onsetFrames = onsetFlux
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > threshold)
    .map((entry) => entry.index);
  const gaps = onsetFrames.slice(1).map((frame, index) => frame - onsetFrames[index]);
  const gapMean = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const gapDeviation = gaps.length
    ? Math.sqrt(gaps.reduce((sum, value) => sum + (value - gapMean) ** 2, 0) / gaps.length)
    : 0;
  const gapVariation = gapMean > 0 ? gapDeviation / gapMean : 1;
  const onsetDensity = onsetFrames.length / Math.max(1, envelope.length);
  const onsetRegularity = gaps.length >= 3 ? clamp(1 - gapVariation) : 0;
  const pulseClarity = getPulseClarity(onsetFlux);
  const envelopePulseClarity = getPulseClarity(envelope);
  const periodicity = Math.max(pulseClarity, envelopePulseClarity * 0.85);
  const regularity = Math.max(onsetRegularity, periodicity);
  const tempoStability = clamp(regularity * 0.75 + (onsetDensity >= 0.03 && onsetDensity <= 0.35 ? 0.25 : 0));

  return {
    energyScore: clamp(mean * 20),
    onsetScore: clamp((onsetMean + onsetDeviation) * 40),
    onsetRegularity: regularity,
    tempoStability,
    crossBandAgreement: clamp(0.35 + regularity * 0.45 + (deviation > 0 ? Math.min(0.2, mean / (deviation + mean)) : 0))
  };
}

function getPulseClarity(values: number[]) {
  if (values.length < ENVELOPE_RATE * 4) return 0;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const normalized = values.map((value) => value - mean);
  let bestCorrelation = 0;

  for (let bpm = MIN_ANALYSIS_BPM; bpm <= MAX_ANALYSIS_BPM; bpm += 1) {
    const lag = Math.round((60 / bpm) * ENVELOPE_RATE);
    if (lag < 2 || lag >= normalized.length / 2) continue;

    let cross = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;

    for (let index = lag; index < normalized.length; index += 1) {
      const left = normalized[index];
      const right = normalized[index - lag];
      cross += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }

    const correlation = leftEnergy > 0 && rightEnergy > 0 ? cross / Math.sqrt(leftEnergy * rightEnergy) : 0;
    bestCorrelation = Math.max(bestCorrelation, correlation);
  }

  return clamp(bestCorrelation);
}

function measureWindow(audioBuffer: AudioBuffer, label: string, startSeconds: number, durationSeconds: number) {
  const stats = getEnvelopeStats(createEnvelope(audioBuffer, startSeconds, durationSeconds));

  return {
    label,
    startSeconds,
    durationSeconds,
    ...stats
  };
}

function findBestWindow(audioBuffer: AudioBuffer, label: string, scoreKey: "energyScore" | "onsetScore") {
  const durationSeconds = Math.min(TARGET_SEGMENT_SECONDS, audioBuffer.duration);
  const maxStart = Math.max(0, audioBuffer.duration - durationSeconds);
  let best = measureWindow(audioBuffer, label, 0, durationSeconds);

  for (let startSeconds = 0; startSeconds <= maxStart; startSeconds += WINDOW_SCAN_STEP_SECONDS) {
    const candidate = measureWindow(audioBuffer, label, startSeconds, durationSeconds);
    if (candidate[scoreKey] > best[scoreKey]) best = candidate;
  }

  return best;
}

export function analyzeAudioPreAnalysis(audioBuffer: AudioBuffer): BpmPreAnalysis {
  const windowSeconds = Math.min(TARGET_SEGMENT_SECONDS, audioBuffer.duration);
  const middleStart = Math.max(0, audioBuffer.duration / 2 - windowSeconds / 2);
  const candidates = [
    measureWindow(audioBuffer, "intro_30s", 0, windowSeconds),
    measureWindow(audioBuffer, "middle_30s", middleStart, windowSeconds),
    findBestWindow(audioBuffer, "high_energy_30s", "energyScore"),
    findBestWindow(audioBuffer, "onset_dense_30s", "onsetScore"),
    measureWindow(audioBuffer, "outro_30s", Math.max(0, audioBuffer.duration - windowSeconds), windowSeconds)
  ];
  const windows = rankAnalysisWindows(candidates);
  const topWindows = windows.slice(0, Math.min(3, windows.length));
  const average = (selector: (window: RankedAnalysisWindow) => number) =>
    topWindows.length ? topWindows.reduce((sum, window) => sum + selector(window), 0) / topWindows.length : 0;
  const profile: RouteProfile = {
    sampleRate: audioBuffer.sampleRate,
    onsetRegularity: average((window) => window.onsetRegularity),
    tempoStability: average((window) => window.tempoStability),
    bassEnergyRatio: 0.2,
    lowBandRegularity: average((window) => window.onsetRegularity) * 0.65,
    midHighRegularity: average((window) => window.onsetRegularity),
    crossBandAgreement: average((window) => window.crossBandAgreement)
  };

  return {
    profile,
    routes: classifyAlgorithmRoutes(profile),
    windows,
    segmentWeights: Object.fromEntries(windows.map((window) => [window.label, window.weightMultiplier]))
  };
}
