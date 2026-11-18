function judgeQc(measure, options) {
  const row = measure || {};
  const range = (options && options.duration) || [24, 70];
  const issues = [];
  if (row.width !== 1080 || row.height !== 1920) issues.push('resolution');
  if (!(Math.abs((Number(row.fps) || 0) - 30) <= 0.5)) issues.push('fps');
  const duration = Number(row.duration_sec) || 0;
  if (duration < range[0] || duration > range[1]) issues.push('duration');
  if (!row.has_audio) issues.push('audio');
  if (row.lufs == null || row.lufs < -15 || row.lufs > -13) issues.push('lufs');
  if (row.true_peak_db != null && row.true_peak_db > -1) issues.push('true_peak');
  if (row.leading_silence_sec != null && row.leading_silence_sec > 0.3) issues.push('leading_silence');
  if (row.black_events) issues.push('black');
  if (row.freeze_events) issues.push('freeze');
  const shots = Number(options && options.shots) || 0;
  if (shots && duration && shots < duration / 3) issues.push('shot_count');
  return { pass: issues.length === 0, issues };
}

module.exports = { judgeQc };
