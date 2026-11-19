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

function hasSeam(bytes, width, height) {
  const list = bytes || [];
  if (list.length < width * height || width < 4 || height < 8) return false;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += list[y * width + x];
    rows.push(sum / width);
  }
  for (let y = 2; y < height - 2; y++) {
    const above = (rows[y - 2] + rows[y - 1]) / 2;
    const below = (rows[y + 1] + rows[y + 2]) / 2;
    if (Math.abs(above - below) > 40 && Math.abs(rows[y] - above) > 25 && Math.abs(rows[y] - below) > 25) return true;
  }
  return false;
}

function tooSimilar(left, right) {
  if (!left || !right) return false;
  return hamming(left, right) < 6;
}

module.exports = { averageHash, hamming, isFlat, tooSimilar, hasSeam };
