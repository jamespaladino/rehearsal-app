// JSON and CSV export of benchmark results.

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function exportJson(report) {
  download(`speech-lab-results-${stamp()}.json`, new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
}

const cell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One row per (engine, take) run, plus per-engine summary rows, in a single CSV.
export function exportCsv(report) {
  const header = [
    'row_type', 'engine', 'take', 'cue', 'cue_end_s', 'duration_s',
    'exact_status', 'exact_detect_s', 'exact_latency_s',
    'fuzzy_status', 'fuzzy_detect_s', 'fuzzy_latency_s', 'fuzzy_score',
    'wer', 'transcript',
    'runs', 'exact_hits', 'exact_missed', 'exact_premature', 'exact_latency_median_s', 'exact_latency_mean_s', 'exact_latency_p90_s',
    'fuzzy_hits', 'fuzzy_missed', 'fuzzy_premature', 'fuzzy_latency_median_s', 'fuzzy_latency_mean_s', 'fuzzy_latency_p90_s',
    'wer_mean', 'load_ms', 'model_bytes', 'runtime_bytes',
  ];
  const lines = [header.join(',')];
  for (const r of report.runs) {
    const m = r.metrics;
    lines.push([
      'run', r.engine, r.take, r.cue, r.cueEnd, r.duration,
      m.exact.status, m.exact.t, m.exact.latency,
      m.fuzzy.status, m.fuzzy.t, m.fuzzy.latency, m.fuzzy.match && m.fuzzy.match.score,
      m.wer, m.transcript,
    ].map(cell).concat(Array(header.length - 15).fill('')).join(','));
  }
  for (const s of report.summary) {
    lines.push([
      'summary', s.engine, '', '', '', '',
      '', '', '', '', '', '', '', '', '',
      s.runs, s.exact.hits, s.exact.missed, s.exact.premature, s.exact.latencyMedian, s.exact.latencyMean, s.exact.latencyP90,
      s.fuzzy.hits, s.fuzzy.missed, s.fuzzy.premature, s.fuzzy.latencyMedian, s.fuzzy.latencyMean, s.fuzzy.latencyP90,
      s.werMean, s.loadMs, s.modelBytes, s.runtimeBytes,
    ].map(cell).join(','));
  }
  download(`speech-lab-results-${stamp()}.csv`, new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
}
