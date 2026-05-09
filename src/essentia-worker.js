import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import { decideListeningBpm } from "./aggregateBpm.ts";

let essentiaPromise = null;

function getEssentia() {
  if (!essentiaPromise) {
    essentiaPromise = Promise.resolve().then(() => new Essentia(EssentiaWASM));
  }

  return essentiaPromise;
}

function readBpmValue(result) {
  const bpm = Number(result?.bpm);
  if (Number.isFinite(bpm) && bpm > 0) return bpm;

  const firstEstimate = Number(result?.estimates?.[0]);
  if (Number.isFinite(firstEstimate) && firstEstimate > 0) return firstEstimate;

  return 0;
}

function releaseVector(vector) {
  if (vector && typeof vector.delete === "function") {
    vector.delete();
  }
}

function runEstimator(essentia, segment, estimator, sampleRate, modelWeightMultipliers) {
  const vector = essentia.arrayToVector(segment.samples);

  try {
    const result = estimator.run(essentia, vector, sampleRate);
    const bpm = readBpmValue(result);
    if (!Number.isFinite(bpm) || bpm <= 0) return null;
    const modelMultiplier = Number(modelWeightMultipliers?.[estimator.model] ?? 1);
    const segmentMultiplier = Number(segment.weightMultiplier ?? 1);

    return {
      bpm,
      model: estimator.model,
      segment: segment.label,
      confidence:
        estimator.confidenceUsable && Number.isFinite(Number(result?.confidence))
          ? Number(result?.confidence)
          : undefined,
      confidenceUsable: estimator.confidenceUsable,
      weight: estimator.weight * (Number.isFinite(modelMultiplier) ? modelMultiplier : 1) * (Number.isFinite(segmentMultiplier) ? segmentMultiplier : 1)
    };
  } finally {
    releaseVector(vector);
  }
}

const BPM_ESTIMATORS = [
  {
    model: "rhythm2013_multifeature",
    weight: 1.2,
    confidenceUsable: true,
    run: (essentia, vector) => essentia.RhythmExtractor2013(vector, 220, "multifeature", 50)
  },
  {
    model: "rhythm2013_degara",
    weight: 0.9,
    confidenceUsable: false,
    run: (essentia, vector) => essentia.RhythmExtractor2013(vector, 220, "degara", 50)
  },
  {
    model: "percival",
    weight: 0.7,
    confidenceUsable: false,
    run: (essentia, vector, sampleRate) =>
      essentia.PercivalBpmEstimator(vector, 2048, 2048, 1024, 1024, 220, 50, sampleRate)
  }
];

function estimateSegmentCandidates(essentia, segment, sampleRate, modelWeightMultipliers) {
  return BPM_ESTIMATORS.map((estimator) => {
    try {
      return runEstimator(essentia, segment, estimator, sampleRate, modelWeightMultipliers);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};

  if (type !== "analyze-bpm") return;

  try {
    const essentia = await getEssentia();
    const candidates = payload.segments.flatMap((segment) =>
      estimateSegmentCandidates(essentia, segment, payload.sampleRate, payload.modelWeightMultipliers)
    );

    if (payload.decision === "candidates-only") {
      self.postMessage({
        id,
        type: "bpm-result",
        payload: {
          candidates
        }
      });
      return;
    }

    const decision = decideListeningBpm(candidates);

    if (!decision.finalBpm) {
      throw new Error("Essentia returned no valid BPM candidates.");
    }

    self.postMessage({
      id,
      type: "bpm-result",
      payload: {
        ...decision,
        candidates
      }
    });
  } catch (error) {
    self.postMessage({
      id,
      type: "bpm-error",
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
};
