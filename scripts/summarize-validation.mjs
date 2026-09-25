import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const finite = Number.isFinite;
const sum = values => values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
const delta = (a, b) => finite(a) && finite(b) ? a - b : null;
const ratio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b : null;
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
const totalInput = (host, u) => host === 'codex' ? u?.inputTokens
  : [u?.inputTokens, u?.cacheReadTokens, u?.cacheWriteTokens].every(finite)
    ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : null;
const share = (host, u) => {
  const total = totalInput(host, u); return total > 0 && finite(u?.cacheReadTokens) ? u.cacheReadTokens / total : null;
};
const distribution = values => {
  const known = values.filter(finite);
  return { n: known.length, unknown: values.length - known.length, median: median(known),
    min: known.length ? Math.min(...known) : null, max: known.length ? Math.max(...known) : null,
    negative: known.filter(n => n < 0).length, zero: known.filter(n => n === 0).length, positive: known.filter(n => n > 0).length };
};
export function tokenTotals(host, rows) {
  const input = sum(rows.map(u => totalInput(host, u))), cached = sum(rows.map(u => u?.cacheReadTokens));
  return { requests: rows.length, inputTokens: input, cacheReadTokens: cached,
    nonCachedInputTokens: sum(rows.map(u => host === 'codex' ? delta(u?.inputTokens, u?.cacheReadTokens) : u?.inputTokens)),
    cacheWriteTokens: sum(rows.map(u => u?.cacheWriteTokens)), outputTokens: sum(rows.map(u => u?.outputTokens)),
    reasoningTokens: sum(rows.map(u => u?.reasoningTokens)), weightedCacheShare: ratio(cached, input),
    zeroCacheRequests: rows.filter(u => u?.cacheReadTokens === 0).length,
    unknownCacheRequests: rows.filter(u => !finite(u?.cacheReadTokens)).length,
    atLeast95PercentCachedRequests: rows.filter(u => share(host, u) >= 0.95).length };
}
function armAnalysis(host, arm) {
  const maintenance = arm.keeperUsage, first = maintenance[0] || arm.nextUserUsage;
  const beforeNext = maintenance.at(-1) || arm.seedUsage;
  const setup = arm.setupUsage || [arm.seedUsage], all = [...setup, ...maintenance, arm.nextUserUsage];
  return { postSeed: tokenTotals(host, [...maintenance, arm.nextUserUsage]), maintenance: tokenTotals(host, maintenance),
    setup: tokenTotals(host, setup), wholeExperiment: tokenTotals(host, all),
    wholeExperimentReportedCostUSD: host === 'claude' ? arm.nextUserUsage?.reportedSessionCostUSD ?? null : sum(all.map(u => u?.costUSD)),
    firstPostSeedInputGrowth: delta(totalInput(host, first), totalInput(host, arm.seedUsage)),
    nextUserReportedCostUSD: host === 'claude'
      ? delta(arm.nextUserUsage?.reportedSessionCostUSD, beforeNext?.reportedSessionCostUSD) : arm.nextUserUsage?.costUSD ?? null,
    maintenanceReportedCostUSD: host === 'claude'
      ? maintenance.length ? delta(beforeNext?.reportedSessionCostUSD, arm.seedUsage?.reportedSessionCostUSD) : 0
      : sum(maintenance.map(u => u?.costUSD)) };
}
export function inputSensitivity(control, keeper) {
  const nonCachedDelta = delta(keeper.nonCachedInputTokens, control.nonCachedInputTokens);
  const cachedDelta = delta(keeper.cacheReadTokens, control.cacheReadTokens);
  return { nonCachedDelta, cachedDelta,
    breakEvenCacheWeight: finite(nonCachedDelta) && cachedDelta > 0 ? -nonCachedDelta / cachedDelta : null,
    scenarios: [0, 0.05, 0.1, 0.25].map(cacheWeight => {
      const known = [nonCachedDelta, cachedDelta].every(finite);
      const change = known ? nonCachedDelta + cacheWeight * cachedDelta : null;
      const baseline = known ? control.nonCachedInputTokens + cacheWeight * control.cacheReadTokens : null;
      return { cacheWeight, inputWeightedDelta: change, relativeChange: ratio(change, baseline) };
    }) };
}
export function summarize(report, study) {
  if (!['claude', 'codex', 'grok'].includes(report.host) || !Array.isArray(report.results)) throw Error('Expected a controlled experiment');
  const pairs = report.results.filter(r => r.valid).map(r => {
    const control = r.control, keeper = r.keeper;
    const controlAnalysis = armAnalysis(report.host, control), keeperAnalysis = armAnalysis(report.host, keeper);
    const comparableCost = finite(control.totalPostSeedReportedCostUSD) && finite(keeper.totalPostSeedReportedCostUSD);
    return { trial: r.trial, order: r.order, controlCacheReadTokens: control.nextUserUsage?.cacheReadTokens,
      keeperCacheReadTokens: keeper.nextUserUsage?.cacheReadTokens,
      controlCacheShare: share(report.host, control.nextUserUsage), keeperCacheShare: share(report.host, keeper.nextUserUsage),
      controlFirstTextMs: control.firstTokenMs, keeperFirstTextMs: keeper.firstTokenMs,
      controlCompletionMs: control.durationMs, keeperCompletionMs: keeper.durationMs,
      controlReportedCostUSD: control.totalPostSeedReportedCostUSD, keeperReportedCostUSD: keeper.totalPostSeedReportedCostUSD,
      reportedCostChangeUSD: comparableCost ? keeper.totalPostSeedReportedCostUSD - control.totalPostSeedReportedCostUSD : null,
      reportedCostChangePercent: comparableCost && control.totalPostSeedReportedCostUSD > 0 ? 100 * (keeper.totalPostSeedReportedCostUSD / control.totalPostSeedReportedCostUSD - 1) : null,
      keeperRequests: keeper.keeperRequests, controlAnalysis, keeperAnalysis,
      cacheShareDelta: delta(share(report.host, keeper.nextUserUsage), share(report.host, control.nextUserUsage)),
      firstTextDeltaMs: delta(keeper.firstTokenMs, control.firstTokenMs), completionDeltaMs: delta(keeper.durationMs, control.durationMs),
      postSeedInputRatio: ratio(keeperAnalysis.postSeed.inputTokens, controlAnalysis.postSeed.inputTokens),
      codexInputSensitivity: report.host === 'codex' ? inputSensitivity(controlAnalysis.postSeed, keeperAnalysis.postSeed) : null };
  });
  const pooled = Object.fromEntries(['control', 'keeper'].map(arm => [arm,
    tokenTotals(report.host, report.results.filter(r => r.valid).flatMap(r => [...r[arm].keeperUsage, r[arm].nextUserUsage]))]));
  return { study, host: report.host, model: report.model, status: report.status ?? null,
    warmupRequestsPerArm: report.warmupRequestsPerArm ?? 0, baselineMeaning: report.baselineMeaning || 'Initial seed completion',
    submittedPrompts: report.submittedPrompts ?? null, maxSubmittedPrompts: report.maxSubmittedPrompts ?? null,
    plannedPairs: report.replicates ?? null, completedValidPairs: pairs.length,
    invalidPairs: report.results.filter(r => !r.valid).map(({ trial, error }) => ({ trial, error })),
    idleMinutes: report.idleMs / 60000, intervalMinutes: report.intervalMs / 60000,
    summary: { controlMedianCacheShare: median(pairs.map(p => p.controlCacheShare)), keeperMedianCacheShare: median(pairs.map(p => p.keeperCacheShare)),
      comparableCostPairs: pairs.filter(p => finite(p.reportedCostChangeUSD)).length,
      pairsWithLowerReportedCost: pairs.filter(p => finite(p.reportedCostChangeUSD) && p.reportedCostChangeUSD < 0).length,
      pairsWithHigherReportedCost: pairs.filter(p => finite(p.reportedCostChangeUSD) && p.reportedCostChangeUSD > 0).length,
      medianReportedCostChangePercent: median(pairs.map(p => p.reportedCostChangePercent)),
      controlMedianFirstTextMs: median(pairs.map(p => p.controlFirstTextMs)), keeperMedianFirstTextMs: median(pairs.map(p => p.keeperFirstTextMs)),
      controlMedianCompletionMs: median(pairs.map(p => p.controlCompletionMs)), keeperMedianCompletionMs: median(pairs.map(p => p.keeperCompletionMs)),
      pairedCacheShareDelta: distribution(pairs.map(p => p.cacheShareDelta)),
      pairedFirstTextDeltaMs: distribution(pairs.map(p => p.firstTextDeltaMs)),
      pairedCompletionDeltaMs: distribution(pairs.map(p => p.completionDeltaMs)),
      medianPostSeedInputRatio: median(pairs.map(p => p.postSeedInputRatio)),
      controlZeroCacheNextRequests: pairs.filter(p => p.controlCacheReadTokens === 0).length,
      keeperZeroCacheNextRequests: pairs.filter(p => p.keeperCacheReadTokens === 0).length,
      controlAtLeast95PercentCachedNextRequests: pairs.filter(p => p.controlCacheShare >= 0.95).length,
      keeperAtLeast95PercentCachedNextRequests: pairs.filter(p => p.keeperCacheShare >= 0.95).length },
    pooled, pooledCodexInputSensitivity: report.host === 'codex' ? inputSensitivity(pooled.control, pooled.keeper) : null,
    pairs, limitations: report.limitations, error: report.error };
}
export function summarizeEndurance(report) {
  const turns = report.turns.filter(t => t.source === 'keeper'), rows = turns.map(t => t.usage);
  return { host: report.host, minutes: report.runMs / 60000, intervalMinutes: report.intervalMs / 60000,
    completedRequests: turns.filter(t => t.status === 'completed').length, maintenance: tokenTotals(report.host, rows),
    cacheReadSequence: rows.map(u => u?.cacheReadTokens ?? null),
    firstMaintenanceInput: totalInput(report.host, rows[0]), lastMaintenanceInput: totalInput(report.host, rows.at(-1)),
    inputGrowth: delta(totalInput(report.host, rows.at(-1)), totalInput(report.host, rows[0])),
    maintenanceReportedCostUSD: report.host === 'claude'
      ? delta(rows.at(-1)?.reportedSessionCostUSD, report.turns.find(t => t.source === 'user')?.usage?.reportedSessionCostUSD)
      : sum(rows.map(u => u?.costUSD)) };
}
if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) throw Error('Pass controlled experiment JSON files or a published measurements bundle');
  const studies = [], endurance = [];
  for (const file of files) {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(report.controlled)) {
      studies.push(...report.controlled.map(r => summarize(r, r.study)));
      endurance.push(...(report.endurance || []).map(summarizeEndurance));
    } else studies.push(summarize(report, basename(file, '.json')));
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(),
    costMeaning: 'Provider CLI estimates including maintenance; not subscription invoices or isolated quota measurements.',
    inputSensitivityMeaning: 'Hypothetical noncached + weight * cached input only; excludes output and unknown cache-write premiums. Negative thresholds admit no positive cache weight. Not a price or quota estimate.',
    pairedMeaning: 'Keeper minus control within each pair; negative latency deltas are faster. Descriptive, no independence or causal claim.',
    studies, endurance }, null, 2));
}
