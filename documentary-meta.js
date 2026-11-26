const BANNED = new Set(['chaos', 'therapy', 'epoch', 'viral', 'fyp', 'foryou', 'trending', 'shorts', 'reels', 'tiktok']);
const STOP = new Set(['the', 'and', 'that', 'with', 'from', 'this', 'after', 'before', 'into', 'over', 'his', 'her', 'their', 'was', 'were', 'have', 'been', 'for', 'you', 'your', 'faced', 'about']);

function topicHashtags(text, extra) {
  const tags = [];
  const seen = new Set();
  function add(word) {
    const clean = String(word || '').toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]/g, '');
    if (clean.length < 3 || BANNED.has(clean) || STOP.has(clean) || seen.has(clean) || tags.length >= 5) return;
    seen.add(clean);
    tags.push(`#${clean}`);
  }
  (extra || []).forEach(add);
  String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach(add);
  return tags.slice(0, 5);
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/\s+\S*$/, '').trim();
}

function buildMetadata({ channel, topic, bible, scriptWords, hookVariants, sources, graphicLanguage, topicTags }) {
  const title = clip(topic || (bible && bible.logline) || channel, 80);
  const description = clip(
    (bible && bible.logline) || topic || '',
    180
  );
  const tags = topicHashtags(`${title} ${description}`, topicTags);
  return {
    channel,
    title,
    description,
    hashtags: tags.slice(0, 5),
    platforms: {
      reels: { caption: `${title} ${tags.join(' ')}`.trim() },
      shorts: { title, description },
      x: { text: clip(`${title} ${tags.slice(0, 3).join(' ')}`, 240) }
    },
    ai_generated: true,
    words: scriptWords || 0,
    spoils_ending: false,
    hook_variants: hookVariants || [],
    sources: sources || [],
    content_warnings: { graphic_language: Boolean(graphicLanguage) },
    topic_tags: topicTags || [],
    ai_flag: true
  };
}

function fileNameFor(day, channel, title) {
  const slug = String(title || 'film').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'film';
  return `${day}_${channel}_${slug}.mp4`;
}

module.exports = { buildMetadata, fileNameFor, clip, topicHashtags };
