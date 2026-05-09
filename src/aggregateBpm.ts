export type BpmConfidence = "high" | "medium-high" | "medium" | "low" | "ambiguous";

export type ListeningModel = "rhythm2013_multifeature" | "rhythm2013_degara" | "percival" | string;

export interface ListeningCandidate {
  bpm: number;
  model: ListeningModel;
  segment: string;
  confidence?: number;
  confidenceUsable?: boolean;
  weight?: number;
}

export interface ListeningClusterSummary {
  bpm: number;
  score: number;
  count: number;
  kind: "raw" | "tempoFamily";
  segments: string[];
}

export interface ListeningCandidateSummary {
  bpm: number;
  model: ListeningModel;
  segment: string;
  weight: number;
}

export interface ListeningDecision {
  finalBpm: number;
  bpm: number;
  confidence: BpmConfidence;
  alternativeBpm: {
    half?: number;
    double?: number;
    relatedTempo: number[];
    tempoFamily: number[];
  };
  validCount: number;
  candidates: ListeningCandidateSummary[];
  clusters: ListeningClusterSummary[];
}

export type JudgeBpmSource =
  | "groove_full"
  | "groove_middle"
  | "groove_best_segment"
  | "ejs_full"
  | "ejs_middle"
  | "groove_bass"
  | "groove_high_mid"
  | "ejs_best_segment";

export interface JudgeBpmCandidate {
  bpm: number;
  source: JudgeBpmSource;
  model?: string;
  weight?: number;
}

export interface JudgeBpmCandidateSummary {
  bpm: number;
  source: JudgeBpmSource;
  model?: string;
  weight: number;
}

export interface JudgeBpmClusterFamilyEntry {
  source: JudgeBpmSource;
  bpm: number;
  normalizedBpm: number;
  ratio: 0.5 | 1 | 2;
  weight: number;
}

export interface JudgeBpmClusterSummary {
  centerBpm: number;
  canonicalBpm: number;
  score: number;
  sources: JudgeBpmSource[];
  bpms: number[];
  normalizedBpms: number[];
  family: JudgeBpmClusterFamilyEntry[];
}

export interface JudgeBpmDecision {
  finalBpm: number;
  bpm: number;
  confidence: BpmConfidence;
  alternativeBpm: {
    half?: number;
    double?: number;
    related: number[];
  };
  validCount: number;
  candidates: JudgeBpmCandidateSummary[];
  clusters: JudgeBpmClusterSummary[];
}

export interface SegmentBpmEstimate {
  bpm: number;
  confidence?: number;
  label?: string;
}

export interface AggregatedBpmResult {
  bpm: number;
  confidence: BpmConfidence;
  validCount: number;
  groups: Array<{
    bpm: number;
    count: number;
  }>;
}

const BPM_GROUP_TOLERANCE = 2;
const MIN_VALID_BPM = 40;
const MAX_VALID_BPM = 220;
const LISTENING_MIN_BPM = 50;
const LISTENING_MAX_BPM = 220;
const RAW_CLUSTER_TOLERANCE = 1.5;
const TEMPO_FAMILY_CLUSTER_TOLERANCE = 2;
const JUDGE_MIN_BPM = 50;
const JUDGE_MAX_BPM = 220;
const JUDGE_CLUSTER_TOLERANCE = 1.5;
const JUDGE_SOURCE_WEIGHTS: Record<JudgeBpmSource, number> = {
  ejs_best_segment: 1.25,
  groove_best_segment: 1.2,
  ejs_middle: 1.15,
  groove_middle: 1.1,
  ejs_full: 1,
  groove_full: 1,
  groove_bass: 0.85,
  groove_high_mid: 0.8
};
const OUT_OF_RANGE_WEIGHT_FACTOR = 0.65;
const MODEL_WEIGHTS: Record<string, number> = {
  rhythm2013_multifeature: 1.2,
  rhythm2013_degara: 0.9,
  percival: 0.7
};

interface PreparedListeningCandidate extends ListeningCandidate {
  index: number;
  family: number[];
  effectiveWeight: number;
  rawOutOfRange: boolean;
}

interface ListeningClusterEntry {
  candidate: PreparedListeningCandidate;
  bpm: number;
}

interface ListeningCluster {
  kind: "raw" | "tempoFamily";
  entries: ListeningClusterEntry[];
  bpm: number;
  score: number;
}

interface PreparedJudgeCandidate extends JudgeBpmCandidate {
  index: number;
  effectiveWeight: number;
}

interface JudgeCluster {
  entries: PreparedJudgeCandidate[];
  centerBpm: number;
  canonicalBpm: number;
  normalizedEntries: JudgeBpmClusterFamilyEntry[];
  score: number;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function isValidBpm(bpm: number) {
  return Number.isFinite(bpm) && bpm >= MIN_VALID_BPM && bpm <= MAX_VALID_BPM;
}

function isNear(value: number, target: number, tolerance = BPM_GROUP_TOLERANCE) {
  return Math.abs(value - target) <= tolerance;
}

function weightedAverage(entries: ListeningClusterEntry[]) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.candidate.effectiveWeight, 0);
  if (totalWeight <= 0) return median(entries.map((entry) => entry.bpm));

  return entries.reduce((sum, entry) => sum + entry.bpm * entry.candidate.effectiveWeight, 0) / totalWeight;
}

function isListeningBpmInRange(bpm: number) {
  return bpm >= LISTENING_MIN_BPM && bpm <= LISTENING_MAX_BPM;
}

function isJudgeBpmInRange(bpm: number) {
  return Number.isFinite(bpm) && bpm >= JUDGE_MIN_BPM && bpm <= JUDGE_MAX_BPM;
}

function isPreferredCanonicalBpm(bpm: number) {
  return bpm >= 70 && bpm <= 180;
}

function roundBpm(bpm: number) {
  return Math.round(bpm * 100) / 100;
}

function uniqueSortedBpms(bpms: number[]) {
  return Array.from(new Set(bpms.map((bpm) => roundBpm(bpm)))).sort((a, b) => a - b);
}

function getCandidateWeight(candidate: ListeningCandidate, rawOutOfRange: boolean) {
  const baseWeight = candidate.weight ?? MODEL_WEIGHTS[candidate.model] ?? 1;
  return baseWeight * (rawOutOfRange ? OUT_OF_RANGE_WEIGHT_FACTOR : 1);
}

function getCandidateFamily(bpm: number) {
  return uniqueSortedBpms([bpm / 2, bpm, bpm * 2].filter(isListeningBpmInRange));
}

function prepareListeningCandidates(candidates: ListeningCandidate[]) {
  return candidates
    .map((candidate, index): PreparedListeningCandidate | null => {
      if (!Number.isFinite(candidate.bpm) || candidate.bpm <= 0) return null;

      const family = getCandidateFamily(candidate.bpm);
      if (family.length === 0) return null;

      const rawOutOfRange = !isListeningBpmInRange(candidate.bpm);
      return {
        ...candidate,
        index,
        family,
        rawOutOfRange,
        effectiveWeight: getCandidateWeight(candidate, rawOutOfRange)
      };
    })
    .filter((candidate): candidate is PreparedListeningCandidate => Boolean(candidate));
}

function summarizeListeningCandidates(candidates: PreparedListeningCandidate[]): ListeningCandidateSummary[] {
  return candidates.map((candidate) => ({
    bpm: roundBpm(candidate.bpm),
    model: candidate.model,
    segment: candidate.segment,
    weight: roundBpm(candidate.effectiveWeight)
  }));
}

function getSegmentBonus(segment: string) {
  if (segment === "middle_30s" || segment === "high_energy_30s" || segment === "onset_dense_30s") return 1;
  if (segment === "full_track") return 0.5;
  return 0;
}

function isIntroOutroOnly(segments: Set<string>) {
  return segments.size > 0 && Array.from(segments).every((segment) => segment === "intro_30s" || segment === "outro_30s");
}

function uniqueCandidateCount(entries: ListeningClusterEntry[]) {
  return new Set(entries.map((entry) => entry.candidate.index)).size;
}

function segmentSet(entries: ListeningClusterEntry[]) {
  return new Set(entries.map((entry) => entry.candidate.segment));
}

function valueSpread(entries: ListeningClusterEntry[]) {
  const values = entries.map((entry) => entry.bpm);
  return Math.max(...values) - Math.min(...values);
}

function clusterHasStableHalfDouble(entries: ListeningClusterEntry[], candidates: PreparedListeningCandidate[]) {
  const clusterCandidateIds = new Set(entries.map((entry) => entry.candidate.index));

  return entries.some((entry) =>
    candidates.some((candidate) => {
      if (clusterCandidateIds.has(candidate.index)) return false;
      return candidate.family.some((familyBpm) => Math.abs(familyBpm - entry.bpm) <= TEMPO_FAMILY_CLUSTER_TOLERANCE);
    })
  );
}

function chooseCanonicalFamilyEntries(entries: ListeningClusterEntry[]) {
  const groups: ListeningClusterEntry[][] = [];

  for (const entry of entries) {
    const group = groups.find((candidate) => Math.abs(entry.bpm - weightedAverage(candidate)) <= RAW_CLUSTER_TOLERANCE);
    if (group) {
      group.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  return groups
    .map((group) => {
      const segments = segmentSet(group);
      const prioritySegmentCount = Array.from(segments).filter(
        (segment) => segment === "middle_30s" || segment === "high_energy_30s" || segment === "onset_dense_30s"
      ).length;
      const bpm = weightedAverage(group);

      return {
        bpm,
        entries: group,
        preferredCount: group.filter((entry) => isPreferredCanonicalBpm(entry.bpm)).length,
        prioritySegmentCount,
        weight: group.reduce((sum, entry) => sum + entry.candidate.effectiveWeight, 0)
      };
    })
    .sort(
      (a, b) =>
        b.preferredCount - a.preferredCount ||
        b.prioritySegmentCount - a.prioritySegmentCount ||
        b.weight - a.weight ||
        Math.abs(a.bpm - 120) - Math.abs(b.bpm - 120)
    )[0].entries;
}

function buildClusters(candidates: PreparedListeningCandidate[], kind: "raw" | "tempoFamily") {
  const tolerance = kind === "raw" ? RAW_CLUSTER_TOLERANCE : TEMPO_FAMILY_CLUSTER_TOLERANCE;
  const entries = candidates.flatMap((candidate) => {
    if (kind === "raw") {
      return isListeningBpmInRange(candidate.bpm) ? [{ candidate, bpm: candidate.bpm }] : [];
    }

    return candidate.family.map((bpm) => ({ candidate, bpm }));
  });
  const clusters: ListeningCluster[] = [];

  for (const entry of entries.sort((a, b) => a.bpm - b.bpm)) {
    const cluster = clusters.find((candidate) => Math.abs(entry.bpm - candidate.bpm) <= tolerance);
    if (cluster) {
      cluster.entries.push(entry);
      cluster.bpm = weightedAverage(cluster.entries);
    } else {
      clusters.push({
        kind,
        entries: [entry],
        bpm: entry.bpm,
        score: 0
      });
    }
  }

  return clusters;
}

function scoreCluster(cluster: ListeningCluster, candidates: PreparedListeningCandidate[], mainRawBpm: number | null) {
  const candidateIds = new Set(cluster.entries.map((entry) => entry.candidate.index));
  const uniqueCandidates = Array.from(candidateIds).map((id) => candidates.find((candidate) => candidate.index === id)!);
  const segments = new Set(uniqueCandidates.map((candidate) => candidate.segment));
  let score = uniqueCandidates.reduce((sum, candidate) => sum + candidate.effectiveWeight, 0);

  for (const segment of segments) {
    score += getSegmentBonus(segment);
  }

  if (segments.size >= 2) score += 1.5;

  const spread = valueSpread(cluster.entries);
  if (spread <= 1) score += 2;
  else if (spread <= 2) score += 1;

  if (clusterHasStableHalfDouble(cluster.entries, candidates)) score += 1;
  if (uniqueCandidates.length === 1) score -= 1.5;
  if (isIntroOutroOnly(segments)) score -= 2;
  if (mainRawBpm !== null && Math.abs(cluster.bpm - mainRawBpm) > 5) score -= 2;

  return score;
}

function getMainRawBpm(rawClusters: ListeningCluster[]) {
  const mainCluster = [...rawClusters]
    .map((cluster) => ({
      ...cluster,
      support: uniqueCandidateCount(cluster.entries),
      weight: cluster.entries.reduce((sum, entry) => sum + entry.candidate.effectiveWeight, 0)
    }))
    .sort((a, b) => b.support - a.support || b.weight - a.weight)[0];

  return mainCluster?.bpm ?? null;
}

function getDecisionConfidence(winning: ListeningCluster, runnerUp: ListeningCluster | undefined, validCount: number) {
  if (validCount < 2 || uniqueCandidateCount(winning.entries) < 2) return "low";

  const scoreLead = runnerUp ? winning.score - runnerUp.score : winning.score;
  if (runnerUp && scoreLead < 1) return "ambiguous";

  const segments = segmentSet(winning.entries);
  const hasTempoFamilyPossibility =
    winning.kind === "tempoFamily" ||
    Boolean(
      runnerUp &&
        (Math.abs(winning.bpm / runnerUp.bpm - 2) < 0.05 || Math.abs(runnerUp.bpm / winning.bpm - 2) < 0.05)
    );

  if (segments.size >= 2 && scoreLead >= 2 && !hasTempoFamilyPossibility) return "high";
  if (hasTempoFamilyPossibility) return "medium";

  return "low";
}

function buildAlternativeBpm(finalBpm: number, candidates: PreparedListeningCandidate[]) {
  const family = uniqueSortedBpms(
    candidates.flatMap((candidate) =>
      candidate.family.filter((bpm) => Math.abs(bpm - finalBpm) > 1 && [0.5, 2].some((ratio) => Math.abs(bpm - finalBpm * ratio) <= 2))
    )
  );
  const half = family.find((bpm) => Math.abs(bpm - finalBpm / 2) <= 2);
  const double = family.find((bpm) => Math.abs(bpm - finalBpm * 2) <= 2);

  return {
    half,
    double,
    relatedTempo: family,
    tempoFamily: uniqueSortedBpms([finalBpm, ...family])
  };
}

function uniqueSortedJudgeSources(sources: JudgeBpmSource[]) {
  return Array.from(new Set(sources)).sort();
}

function getJudgeCandidateWeight(candidate: JudgeBpmCandidate) {
  const configuredWeight = candidate.weight ?? JUDGE_SOURCE_WEIGHTS[candidate.source] ?? 1;
  if (!Number.isFinite(configuredWeight) || configuredWeight <= 0) return 0;
  return configuredWeight;
}

function getStrongestSourceWeight(entries: PreparedJudgeCandidate[], source: JudgeBpmSource) {
  return Math.max(0, ...entries.filter((entry) => entry.source === source).map((entry) => entry.effectiveWeight));
}

function isJudgeTempoFamilyRelated(leftBpm: number, rightBpm: number, tolerance = JUDGE_CLUSTER_TOLERANCE) {
  return (
    Math.abs(leftBpm - rightBpm) <= tolerance ||
    Math.abs(leftBpm / 2 - rightBpm) <= tolerance ||
    Math.abs(leftBpm * 2 - rightBpm) <= tolerance ||
    Math.abs(leftBpm - rightBpm / 2) <= tolerance ||
    Math.abs(leftBpm - rightBpm * 2) <= tolerance
  );
}

function normalizeJudgeBpmToTarget(bpm: number, targetBpm: number) {
  const options = [
    { ratio: 1 as const, bpm },
    { ratio: 0.5 as const, bpm: bpm / 2 },
    { ratio: 2 as const, bpm: bpm * 2 }
  ].filter((option) => isJudgeBpmInRange(option.bpm));

  return options.sort((a, b) => Math.abs(a.bpm - targetBpm) - Math.abs(b.bpm - targetBpm))[0];
}

function prepareJudgeCandidates(candidates: JudgeBpmCandidate[]) {
  return candidates
    .map((candidate, index): PreparedJudgeCandidate | null => {
      if (!isJudgeBpmInRange(candidate.bpm)) return null;
      return { ...candidate, index, effectiveWeight: getJudgeCandidateWeight(candidate) };
    })
    .filter((candidate): candidate is PreparedJudgeCandidate => Boolean(candidate));
}

function summarizeJudgeCandidates(candidates: PreparedJudgeCandidate[]): JudgeBpmCandidateSummary[] {
  return candidates.map((candidate) => ({
    bpm: roundBpm(candidate.bpm),
    source: candidate.source,
    model: candidate.model,
    weight: roundBpm(candidate.effectiveWeight)
  }));
}

function chooseJudgeCanonicalBpm(entries: PreparedJudgeCandidate[]) {
  const targets = uniqueSortedBpms(
    entries.flatMap((entry) => [entry.bpm / 2, entry.bpm, entry.bpm * 2].filter(isJudgeBpmInRange))
  );

  return targets
    .map((target) => {
      const normalized = entries
        .map((entry) => normalizeJudgeBpmToTarget(entry.bpm, target))
        .filter((entry) => Math.abs(entry.bpm - target) <= JUDGE_CLUSTER_TOLERANCE);
      const sources = uniqueSortedJudgeSources(
        entries
          .filter((entry) => {
            const normalizedEntry = normalizeJudgeBpmToTarget(entry.bpm, target);
            return Math.abs(normalizedEntry.bpm - target) <= JUDGE_CLUSTER_TOLERANCE;
          })
          .map((entry) => entry.source)
      );
      const preferred = target >= 70 && target <= 180 ? 1 : 0;

      return {
        target,
        support: sources.reduce((sum, source) => {
          const count = entries.filter((entry) => {
            if (entry.source !== source) return false;
            const normalizedEntry = normalizeJudgeBpmToTarget(entry.bpm, target);
            return Math.abs(normalizedEntry.bpm - target) <= JUDGE_CLUSTER_TOLERANCE;
          }).length;
          return sum + Math.min(count, 1.2) * getStrongestSourceWeight(entries, source);
        }, 0),
        sourceCount: sources.length,
        weight: sources.reduce((sum, source) => sum + getStrongestSourceWeight(entries, source), 0),
        preferred
      };
    })
    .sort(
      (a, b) =>
        b.support - a.support ||
        b.sourceCount - a.sourceCount ||
        b.preferred - a.preferred ||
        b.weight - a.weight ||
        Math.abs(a.target - 120) - Math.abs(b.target - 120)
    )[0].target;
}

function buildJudgeNormalizedEntries(entries: PreparedJudgeCandidate[], canonicalBpm: number) {
  return entries.map((entry) => {
    const normalized = normalizeJudgeBpmToTarget(entry.bpm, canonicalBpm);

    return {
      source: entry.source,
      bpm: roundBpm(entry.bpm),
      normalizedBpm: roundBpm(normalized.bpm),
      ratio: normalized.ratio,
      weight: roundBpm(entry.effectiveWeight)
    };
  });
}

function getJudgeWeightedAverage(entries: JudgeBpmClusterFamilyEntry[]) {
  const sourceGroups = uniqueSortedJudgeSources(entries.map((entry) => entry.source)).map((source) => {
    const sourceEntries = entries.filter((entry) => entry.source === source);
    return {
      source,
      bpm: sourceEntries.reduce((sum, entry) => sum + entry.normalizedBpm, 0) / sourceEntries.length,
      weight: Math.max(...sourceEntries.map((entry) => entry.weight))
    };
  });
  const totalWeight = sourceGroups.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return median(sourceGroups.map((entry) => entry.bpm));

  return sourceGroups.reduce((sum, entry) => sum + entry.bpm * entry.weight, 0) / totalWeight;
}

function scoreJudgeCluster(entries: PreparedJudgeCandidate[]) {
  const sources = uniqueSortedJudgeSources(entries.map((entry) => entry.source));
  const perSourceCandidateScore = sources.reduce((sum, source) => {
    const count = entries.filter((entry) => entry.source === source).length;
    return sum + Math.min(count, 1.2) * getStrongestSourceWeight(entries, source);
  }, 0);
  const sourceReliabilityScore = sources.reduce((sum, source) => sum + getStrongestSourceWeight(entries, source), 0);
  let score = perSourceCandidateScore + sourceReliabilityScore;

  const hasGroove = sources.some((source) => source.startsWith("groove_"));
  const hasEjs = sources.some((source) => source.startsWith("ejs_"));
  const hasFull = sources.some((source) => source.endsWith("_full"));
  const hasSegment = sources.some((source) => source.includes("_middle") || source.includes("_best_segment"));
  const hasMiddle = sources.some((source) => source.includes("_middle"));
  const hasBestSegment = sources.some((source) => source.includes("_best_segment"));

  if (hasGroove && hasEjs) score += 2;
  if (hasFull && hasSegment) score += 1;
  if (hasMiddle) score += 0.5;
  if (hasBestSegment) score += 0.5;

  const grooveFullEntries = entries.filter((entry) => entry.source === "groove_full");
  const grooveBassEntries = entries.filter((entry) => entry.source === "groove_bass");
  const bassFullIsStable = grooveFullEntries.some((fullEntry) =>
    grooveBassEntries.some(
      (bassEntry) =>
        Math.abs(fullEntry.bpm / 2 - bassEntry.bpm) <= JUDGE_CLUSTER_TOLERANCE ||
        Math.abs(fullEntry.bpm * 2 - bassEntry.bpm) <= JUDGE_CLUSTER_TOLERANCE ||
        Math.abs(bassEntry.bpm / 2 - fullEntry.bpm) <= JUDGE_CLUSTER_TOLERANCE ||
        Math.abs(bassEntry.bpm * 2 - fullEntry.bpm) <= JUDGE_CLUSTER_TOLERANCE
    )
  );

  if (bassFullIsStable) score += 1;

  return score;
}

function buildJudgeClusters(candidates: PreparedJudgeCandidate[]) {
  const clusters: JudgeCluster[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.bpm - b.bpm)) {
    const cluster = clusters.find((candidateCluster) =>
      candidateCluster.entries.some((entry) => isJudgeTempoFamilyRelated(candidate.bpm, entry.bpm))
    );

    if (cluster) {
      cluster.entries.push(candidate);
      cluster.canonicalBpm = chooseJudgeCanonicalBpm(cluster.entries);
      cluster.normalizedEntries = buildJudgeNormalizedEntries(cluster.entries, cluster.canonicalBpm);
      cluster.centerBpm = getJudgeWeightedAverage(cluster.normalizedEntries);
      cluster.score = scoreJudgeCluster(cluster.entries);
    } else {
      const normalizedEntries = buildJudgeNormalizedEntries([candidate], candidate.bpm);
      clusters.push({
        entries: [candidate],
        centerBpm: candidate.bpm,
        canonicalBpm: candidate.bpm,
        normalizedEntries,
        score: scoreJudgeCluster([candidate])
      });
    }
  }

  return clusters.map((cluster) => ({
    ...cluster,
    centerBpm: getJudgeWeightedAverage(cluster.normalizedEntries)
  }));
}

function getJudgeConfidence(winning: JudgeCluster, runnerUp: JudgeCluster | undefined, validCount: number) {
  if (validCount < 3) return "low";
  if (uniqueSortedJudgeSources(winning.entries.map((entry) => entry.source)).length < 2) return "low";
  if (!runnerUp) return "high";

  const scoreLead = winning.score - runnerUp.score;
  if (scoreLead < 2) return "ambiguous";
  if (isJudgeTempoFamilyRelated(winning.canonicalBpm, runnerUp.canonicalBpm) && scoreLead < 3) return "ambiguous";

  return "high";
}

function buildJudgeAlternativeBpm(finalBpm: number, clusters: JudgeCluster[]) {
  const related = uniqueSortedBpms(
    clusters
      .flatMap((cluster) => [cluster.canonicalBpm, cluster.canonicalBpm / 2, cluster.canonicalBpm * 2])
      .filter((bpm) => isJudgeBpmInRange(bpm) && Math.abs(bpm - finalBpm) > 1)
  );
  const half = related.find((bpm) => Math.abs(bpm - finalBpm / 2) <= JUDGE_CLUSTER_TOLERANCE);
  const double = related.find((bpm) => Math.abs(bpm - finalBpm * 2) <= JUDGE_CLUSTER_TOLERANCE);

  return {
    half,
    double,
    related
  };
}

function sameCandidateSet(left: ListeningClusterEntry[], right: ListeningClusterEntry[]) {
  const leftIds = new Set(left.map((entry) => entry.candidate.index));
  const rightIds = new Set(right.map((entry) => entry.candidate.index));
  if (leftIds.size !== rightIds.size) return false;

  return Array.from(leftIds).every((id) => rightIds.has(id));
}

function isEquivalentDecisionCluster(left: ListeningCluster, right: ListeningCluster) {
  if (!sameCandidateSet(left.entries, right.entries)) return false;
  if (Math.abs(left.bpm - right.bpm) <= TEMPO_FAMILY_CLUSTER_TOLERANCE) return true;

  return left.kind === "tempoFamily" || right.kind === "tempoFamily";
}

function groupBpms(bpms: number[]) {
  const groups: number[][] = [];

  for (const bpm of [...bpms].sort((a, b) => a - b)) {
    const group = groups.find((candidate) => isNear(bpm, median(candidate)));
    if (group) {
      group.push(bpm);
    } else {
      groups.push([bpm]);
    }
  }

  return groups
    .map((group) => ({
      bpm: median(group),
      count: group.length,
      values: group
    }))
    .sort((a, b) => b.count - a.count || a.bpm - b.bpm);
}

function hasHalfDoublePattern(bpms: number[], referenceBpm: number) {
  const relatedCount = bpms.filter(
    (bpm) => isNear(bpm, referenceBpm) || isNear(bpm, referenceBpm / 2) || isNear(bpm, referenceBpm * 2)
  ).length;

  return relatedCount >= Math.ceil(bpms.length * 0.75);
}

export function aggregateBpm(estimates: SegmentBpmEstimate[]): AggregatedBpmResult {
  const validBpms = estimates.map((estimate) => estimate.bpm).filter(isValidBpm);

  if (validBpms.length === 0) {
    return {
      bpm: 0,
      confidence: "low",
      validCount: 0,
      groups: []
    };
  }

  const grouped = groupBpms(validBpms);
  const strongest = grouped[0];
  const majorityCount = Math.ceil(validBpms.length * 0.6);
  const hasMajorityGroup = strongest.count >= majorityCount;
  const hasRelatedTempoPattern = hasHalfDoublePattern(validBpms, strongest.bpm);

  return {
    bpm: strongest.bpm,
    confidence: hasMajorityGroup ? "high" : hasRelatedTempoPattern ? "medium" : "low",
    validCount: validBpms.length,
    groups: grouped.map((group) => ({
      bpm: group.bpm,
      count: group.count
    }))
  };
}

export function decideJudgeBpm(candidates: JudgeBpmCandidate[]): JudgeBpmDecision {
  const validCandidates = prepareJudgeCandidates(candidates);

  if (validCandidates.length === 0) {
    return {
      finalBpm: 0,
      bpm: 0,
      confidence: "low",
      alternativeBpm: {
        related: []
      },
      validCount: 0,
      candidates: [],
      clusters: []
    };
  }

  const scoredClusters = buildJudgeClusters(validCandidates).sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta) return scoreDelta;

    const aPreferred = isPreferredCanonicalBpm(a.canonicalBpm) ? 1 : 0;
    const bPreferred = isPreferredCanonicalBpm(b.canonicalBpm) ? 1 : 0;
    return (
      bPreferred - aPreferred ||
      uniqueSortedJudgeSources(b.entries.map((entry) => entry.source)).length -
        uniqueSortedJudgeSources(a.entries.map((entry) => entry.source)).length ||
      Math.abs(a.canonicalBpm - 120) - Math.abs(b.canonicalBpm - 120)
    );
  });
  const winning = scoredClusters[0];
  const runnerUp = scoredClusters[1];
  const finalBpm = roundBpm(winning.centerBpm);

  return {
    finalBpm,
    bpm: finalBpm,
    confidence: getJudgeConfidence(winning, runnerUp, validCandidates.length),
    alternativeBpm: buildJudgeAlternativeBpm(finalBpm, scoredClusters),
    validCount: validCandidates.length,
    candidates: summarizeJudgeCandidates(validCandidates),
    clusters: scoredClusters.map((cluster) => ({
      centerBpm: roundBpm(cluster.centerBpm),
      canonicalBpm: roundBpm(cluster.canonicalBpm),
      score: roundBpm(cluster.score),
      sources: uniqueSortedJudgeSources(cluster.entries.map((entry) => entry.source)),
      bpms: cluster.entries.map((entry) => roundBpm(entry.bpm)),
      normalizedBpms: cluster.normalizedEntries.map((entry) => roundBpm(entry.normalizedBpm)),
      family: cluster.normalizedEntries
    }))
  };
}

export function decideListeningBpm(candidates: ListeningCandidate[]): ListeningDecision {
  const validCandidates = prepareListeningCandidates(candidates);

  if (validCandidates.length === 0) {
    return {
      finalBpm: 0,
      bpm: 0,
      confidence: "low",
      alternativeBpm: {
        relatedTempo: [],
        tempoFamily: []
      },
      validCount: 0,
      candidates: [],
      clusters: []
    };
  }

  const rawClusters = buildClusters(validCandidates, "raw");
  const familyClusters = buildClusters(validCandidates, "tempoFamily");
  const mainRawBpm = getMainRawBpm(rawClusters);
  const scoredClusters = [...rawClusters, ...familyClusters]
    .map((cluster) => ({
      ...cluster,
      score: scoreCluster(cluster, validCandidates, mainRawBpm)
    }))
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta) return scoreDelta;

      const aPreferred = isPreferredCanonicalBpm(a.bpm) ? 1 : 0;
      const bPreferred = isPreferredCanonicalBpm(b.bpm) ? 1 : 0;
      return bPreferred - aPreferred || b.entries.length - a.entries.length || Math.abs(a.bpm - 120) - Math.abs(b.bpm - 120);
    });
  const winning = scoredClusters[0];
  const runnerUp = scoredClusters.slice(1).find((cluster) => !isEquivalentDecisionCluster(winning, cluster));
  const finalEntries = winning.kind === "tempoFamily" ? chooseCanonicalFamilyEntries(winning.entries) : winning.entries;
  const finalBpm = roundBpm(weightedAverage(finalEntries));

  return {
    finalBpm,
    bpm: finalBpm,
    confidence: getDecisionConfidence({ ...winning, entries: finalEntries, bpm: finalBpm }, runnerUp, validCandidates.length),
    alternativeBpm: buildAlternativeBpm(finalBpm, validCandidates),
    validCount: validCandidates.length,
    candidates: summarizeListeningCandidates(validCandidates),
    clusters: scoredClusters.map((cluster) => ({
      bpm: roundBpm(cluster.bpm),
      score: roundBpm(cluster.score),
      count: uniqueCandidateCount(cluster.entries),
      kind: cluster.kind,
      segments: Array.from(segmentSet(cluster.entries)).sort()
    }))
  };
}
