/**
 * Belgesel hattının bayrakları. Varsayılanlar bugünkü üretimi değiştirmez.
 * Yeni davranış ancak ilgili bayrak açılınca devreye girer.
 */
const STYLE_SUFFIX = Object.freeze({
  epoch: ', cinematic dark horror/mystery documentary still, moody chiaroscuro lighting, dramatic shadows, desaturated cold color palette, hyper-realistic, 8k resolution, film grain, grim atmosphere, no bright colors',
  chaos: ', cinematic dark horror/mystery documentary still, moody chiaroscuro lighting, dramatic shadows, desaturated cold color palette, hyper-realistic, 8k resolution, film grain, grim atmosphere, no bright colors',
  therapy: ', surreal psychological thriller cinematography, dark shadows, silhouette in fog, eerie minimalist lighting, cold blue and black tones, hyper-realistic, 8k resolution, film grain, no bright colors'
});

const DOC_CONFIG = Object.freeze({
  STORY_PIPELINE: 'v1',
  OUTPUT_LAYOUT: 'legacy',
  CHAOS_SOURCE: 'reddit_premise',
  shots_per_scene: 1,
  layout: 'card',
  TTS_MODEL: 'eleven_multilingual_v2',
  duration_range: Object.freeze({
    epoch: Object.freeze([40, 50]),
    chaos: Object.freeze([40, 50]),
    therapy: Object.freeze([40, 50])
  }),
  word_target: Object.freeze({ aimMin: 80, aimMax: 90, acceptMin: 60, acceptMax: 140 }),
  STYLE_SUFFIX,
  safe_area: Object.freeze({
    top: 250,
    bottom: 450,
    right: 120,
    captionYMin: 1100,
    captionYMax: 1270
  }),
  music_volume: 0.07
});

function pick(env, name, fallback, allowed) {
  const raw = String(env[name] || '').trim();
  if (!raw) return fallback;
  if (allowed && allowed.indexOf(raw) < 0) return fallback;
  return raw;
}

function loadDocConfig(env) {
  const source = env || process.env;
  return Object.freeze({
    ...DOC_CONFIG,
    STORY_PIPELINE: pick(source, 'STORY_PIPELINE', DOC_CONFIG.STORY_PIPELINE, ['v1', 'v2']),
    OUTPUT_LAYOUT: pick(source, 'OUTPUT_LAYOUT', DOC_CONFIG.OUTPUT_LAYOUT, ['legacy', 'jobs']),
    CHAOS_SOURCE: pick(source, 'CHAOS_SOURCE', DOC_CONFIG.CHAOS_SOURCE, ['reddit_premise', 'original']),
    layout: pick(source, 'DOC_LAYOUT', DOC_CONFIG.layout, ['card', 'fullbleed']),
    TTS_MODEL: pick(source, 'TTS_MODEL', DOC_CONFIG.TTS_MODEL),
    shots_per_scene: DOC_CONFIG.shots_per_scene
  });
}

module.exports = { DOC_CONFIG, loadDocConfig, STYLE_SUFFIX };
