function finiteValues(values) {
  return values.filter((value) => Number.isFinite(value));
}

export function percentile(values, quantile) {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];

  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];

  const fraction = position - lowerIndex;
  return sorted[lowerIndex] + ((sorted[upperIndex] - sorted[lowerIndex]) * fraction);
}

export function classifyThermalState(targetActivationCount) {
  if (targetActivationCount <= 0) return "cold";
  if (targetActivationCount === 1) return "warm";
  return "cached";
}

function summarizeSamples(samples) {
  const durations = samples.map((sample) => sample.durationMs);
  const appOwnedDurations = samples.map((sample) => {
    const inputToStateUpdateMs = sample.phases?.inputToStateUpdateMs;
    const stateUpdateToCommitMs = sample.phases?.stateUpdateToCommitMs;
    return Number.isFinite(inputToStateUpdateMs) && Number.isFinite(stateUpdateToCommitMs)
      ? inputToStateUpdateMs + stateUpdateToCommitMs
      : null;
  });
  const presentationDurations = samples.map((sample) => sample.phases?.commitToStableFrameMs);
  return {
    count: samples.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    appOwnedP50Ms: percentile(appOwnedDurations, 0.5),
    appOwnedP95Ms: percentile(appOwnedDurations, 0.95),
    presentationP50Ms: percentile(presentationDurations, 0.5),
    presentationP95Ms: percentile(presentationDurations, 0.95),
    samplesMs: durations,
  };
}

export function summarizeDirectionalTransitions(samples) {
  const summary = {};
  for (const direction of ["comics-to-books", "books-to-comics"]) {
    const directional = samples.filter((sample) => sample.direction === direction);
    summary[direction] = {
      all: summarizeSamples(directional),
      cold: summarizeSamples(directional.filter((sample) => sample.thermalState === "cold")),
      warm: summarizeSamples(directional.filter((sample) => sample.thermalState === "warm")),
      cached: summarizeSamples(directional.filter((sample) => sample.thermalState === "cached")),
    };
  }
  return summary;
}

export function summarizeResourceGrowth(samples, keys) {
  const result = {};
  for (const key of keys) {
    const values = finiteValues(samples.map((sample) => Number(sample?.[key])));
    if (values.length === 0) {
      result[key] = { first: null, last: null, max: null, delta: null, monotonicIncrease: false };
      continue;
    }
    result[key] = {
      first: values[0],
      last: values.at(-1),
      max: Math.max(...values),
      delta: values.at(-1) - values[0],
      monotonicIncrease: values.length > 1
        && values.every((value, index) => index === 0 || value > values[index - 1]),
    };
  }
  return result;
}
