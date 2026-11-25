const TAGS = Object.freeze({
  epoch: ['#epoch', '#darkhistory', '#mystery', '#unsolved', '#history'],
  chaos: ['#chaos', '#creepy', '#horror', '#mystery', '#scary'],
  therapy: ['#therapy', '#psychology', '#darkpsychology', '#mind', '#experiment']
});

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/\s+\S*$/, '').trim();
}

function buildMetadata({ channel, topic, bible, scriptWords, hookVariants, sources, graphicLanguage, topicTags }) {
  const tags = TAGS[channel] || TAGS.epoch;
  const title = clip(topic || (bible && bible.logline) || channel, 80);
  const description = clip(
    (bible && bible.logline) || topic || '',
    180
  );
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

module.exports = { TAGS, buildMetadata, fileNameFor, clip };
