function averageHash(bytes) {
  const list = Array.from(bytes || []);
  if (list.length < 16) return '';
  const sum = list.reduce((total, value) => total + value, 0);
  const avg = sum / list.length;
  return list.map((value) => (value >= avg ? '1' : '0')).join('');
}

function hamming(left, right) {
  const size = Math.min(String(left || '').length, String(right || '').length);
  let score = 0;
  for (let i = 0; i < size; i++) if (left[i] !== right[i]) score += 1;
  return score;
}

function isFlat(bytes) {
  const list = Array.from(bytes || []);
  if (!list.length) return true;
  let min = 255;
  let max = 0;
  list.forEach((value) => {
    if (value < min) min = value;
    if (value > max) max = value;
  });
  return max - min < 8;
}

function tooSimilar(left, right) {
  if (!left || !right) return false;
  return hamming(left, right) < 6;
}

module.exports = { averageHash, hamming, isFlat, tooSimilar };
