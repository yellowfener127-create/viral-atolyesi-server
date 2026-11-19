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

function seamClusters(bytes, width, height, vertical) {
  const lines = vertical ? width : height;
  const span = vertical ? height : width;
  const margin = Math.max(2, Math.floor(lines * 0.08));
  const raw = [];
  for (let i = 1; i < lines; i++) {
    let jumps = 0;
    for (let j = 0; j < span; j++) {
      const here = bytes[vertical ? j * width + i : i * width + j];
      const prev = bytes[vertical ? j * width + (i - 1) : (i - 1) * width + j];
      if (Math.abs(here - prev) > 32) jumps += 1;
    }
    if (i > margin && i < lines - margin && jumps / span > 0.65) raw.push(i);
  }
  const clusters = [];
  raw.forEach((pos) => {
    const last = clusters[clusters.length - 1];
    if (last && pos - last[last.length - 1] <= 8) last.push(pos);
    else clusters.push([pos]);
  });
  return clusters;
}

function cleanGutter(bytes, width, height, vertical, cluster) {
  const span = vertical ? height : width;
  return cluster.some((pos) => {
    let sum = 0;
    let sum2 = 0;
    for (let j = 0; j < span; j++) {
      const value = bytes[vertical ? j * width + pos : pos * width + j];
      sum += value;
      sum2 += value * value;
    }
    const mean = sum / span;
    const variance = sum2 / span - mean * mean;
    return variance < 40 && (mean < 24 || mean > 235);
  });
}

function isStacked(bytes, width, height) {
  const list = bytes || [];
  if (list.length < width * height || width < 16 || height < 16) return false;
  const horizontal = seamClusters(list, width, height, false);
  const vertical = seamClusters(list, width, height, true);
  if (horizontal.length >= 2) return true;
  if (horizontal.length && vertical.length) return true;
  if (horizontal.some((cluster) => cleanGutter(list, width, height, false, cluster))) return true;
  if (vertical.some((cluster) => cleanGutter(list, width, height, true, cluster))) return true;
  return false;
}

function tooSimilar(left, right) {
  if (!left || !right) return false;
  return hamming(left, right) < 6;
}

module.exports = { averageHash, hamming, isFlat, tooSimilar, hasSeam, isStacked };
