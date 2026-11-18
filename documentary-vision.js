function sampleTimes(duration, count) {
  const total = Math.max(0.2, Number(duration) || 0);
  const n = Math.max(1, Number(count) || 8);
  const times = [];
  for (let i = 0; i < n; i++) {
    times.push(Math.min(total - 0.01, total * ((i + 0.5) / n)));
  }
  return times;
}

function shotAt(shots, time) {
  const t = Number(time) || 0;
  const list = shots || [];
  for (let i = 0; i < list.length; i++) {
    const start = Number(list[i].start) || 0;
    const end = Number(list[i].end) || start;
    if (t >= start && t < end) return i;
  }
  return Math.max(0, list.length - 1);
}

function shotsToRedo(frames) {
  const worst = new Map();
  (frames || []).forEach((frame) => {
    const shot = Number(frame && frame.shot);
    const score = Number(frame && frame.score);
    if (!Number.isInteger(shot) || shot < 0 || !Number.isFinite(score)) return;
    const next = worst.has(shot) ? Math.min(worst.get(shot), score) : score;
    worst.set(shot, next);
  });
  const redo = [];
  worst.forEach((score, shot) => {
    if (score < 3) redo.push(shot);
  });
  return redo.sort((a, b) => a - b);
}

function visionPrompt(samples) {
  const lines = (samples || []).map((sample, index) => (
    `Frame ${index + 1} is shot ${sample.shot}. Spoken line: ${sample.line}`
  ));
  return [
    'Score each still against its spoken line.',
    'Score 5 when the main object or action in the line is visible.',
    'Score 1 when the picture shows something else.',
    'Judge the noun and the action, not the color grade.',
    'Return JSON only.',
    lines.join('\n')
  ].join('\n');
}

const VISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    frames: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          frame: { type: 'INTEGER' },
          shot: { type: 'INTEGER' },
          score: { type: 'INTEGER' }
        },
        required: ['frame', 'shot', 'score']
      }
    }
  },
  required: ['frames']
};

module.exports = { sampleTimes, shotAt, shotsToRedo, visionPrompt, VISION_SCHEMA };
