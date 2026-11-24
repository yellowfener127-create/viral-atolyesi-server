const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'ViralAtolyesi/1.0 (local documentary tool)';
const USED_FILE = path.join(__dirname, 'data', 'used_stories.json');
const MAX_USED = 2000;

const NAME_COL = /name|person|victim|deceased|individual|who|isim|ad[ıi]|ki[sş]i/i;
const DATE_COL = /date|death|died|year|when|tarih|[oö]l[uü]m/i;
const PLACE_COL = /country|place|location|city|where|nation|site|missing|[uü]lke|yer|[sş]ehir|konum/i;
const STORY_COL = /detail|description|notes|circumstance|cause|summary|account|story|event|a[cç][ıi]klama|ayr[ıi]nt[ıi]|olay/i;
const IMAGE_COL = /image|picture|photo|portrait|resim|g[oö]rsel/i;
const META_SECTION = /^(notes|references|see also|external links|bibliography|further reading|sources|kaynak[cç]a|notlar|ayrıca bak[ıi]n[ıi]z)$/i;

function resolveWikiTarget(input) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    const error = new Error('Wikipedia adresi veya sayfa başlığı gerekli.');
    error.statusCode = 400;
    throw error;
  }
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch {
      const error = new Error('Wikipedia adresi okunamadı.');
      error.statusCode = 400;
      throw error;
    }
    const host = url.hostname.replace(/^www\./, '');
    const match = host.match(/^([a-z-]{2,12})\.wikipedia\.org$/i);
    if (!match) {
      const error = new Error('Yalnızca Wikipedia sayfası kabul edilir.');
      error.statusCode = 400;
      throw error;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const wikiAt = parts.findIndex((part) => part === 'wiki' || part === 'w');
    const slug = wikiAt >= 0 ? parts.slice(wikiAt + 1).join('/') : parts[parts.length - 1];
    const title = decodeURIComponent(String(slug || '').replace(/_/g, ' ')).trim();
    if (!title || title.length > 300) {
      const error = new Error('Sayfa başlığı okunamadı.');
      error.statusCode = 400;
      throw error;
    }
    return { lang: match[1].toLowerCase(), title };
  }
  const title = raw.replace(/_/g, ' ').replace(/^\/+/, '').trim();
  if (!title || title.length > 300 || /[<>]/.test(title)) {
    const error = new Error('Sayfa başlığı 300 karakterden kısa olsun.');
    error.statusCode = 400;
    throw error;
  }
  return { lang: 'en', title };
}

function wikiUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

async function wikiGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error('Wikipedia yanıt vermedi.');
    error.statusCode = 502;
    throw error;
  }
  if (data && data.error) {
    const missing = data.error.code === 'missingtitle';
    const error = new Error(missing ? 'Wikipedia sayfası bulunamadı.' : 'Wikipedia bu sayfayı açamadı.');
    error.statusCode = missing ? 404 : 502;
    throw error;
  }
  return data;
}

async function fetchWikipedia(input) {
  const target = resolveWikiTarget(input);
  const api = `https://${target.lang}.wikipedia.org/w/api.php`;
  const parseUrl = new URL(api);
  parseUrl.search = new URLSearchParams({
    action: 'parse',
    page: target.title,
    prop: 'wikitext|displaytitle',
    redirects: '1',
    format: 'json',
    formatversion: '2'
  }).toString();
  const extractUrl = new URL(api);
  extractUrl.search = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    exchars: '1200',
    redirects: '1',
    titles: target.title,
    format: 'json',
    formatversion: '2'
  }).toString();
  const [parsed, queried] = await Promise.all([wikiGet(parseUrl), wikiGet(extractUrl)]);
  const page = parsed.parse;
  if (!page || typeof page.wikitext !== 'string') {
    const error = new Error('Wikipedia sayfası bulunamadı.');
    error.statusCode = 404;
    throw error;
  }
  const queryPage = (((queried.query || {}).pages) || [])[0] || {};
  const redirected = Array.isArray(page.redirects) && page.redirects[0] ? page.redirects[0].from : '';
  const built = parseWikitext(page.wikitext, page.title);
  return {
    ok: true,
    lang: target.lang,
    title: page.title,
    pageid: page.pageid || queryPage.pageid || null,
    url: wikiUrl(target.lang, page.title),
    redirected_from: redirected || null,
    extract: String(queryPage.extract || '').replace(/\s+/g, ' ').trim(),
    sections: built.sections,
    tables: built.tables,
    rows: built.rows,
    links: built.links
  };
}

function parseWikitext(wikitext, pageTitle) {
  const source = String(wikitext || '').replace(/<!--[\s\S]*?-->/g, '');
  const headings = [];
  const headingRe = /^(={2,6})\s*([^=\n]+?)\s*\1[ \t]*$/gm;
  let match = headingRe.exec(source);
  while (match) {
    headings.push({
      start: match.index,
      end: match.index + match[0].length,
      level: match[1].length,
      title: cleanInline(match[2])
    });
    match = headingRe.exec(source);
  }
  const tables = extractTables(source).map((table, index) => {
    const section = sectionAt(headings, table.start);
    const parsed = parseTable(table.raw);
    const sectionTitle = section ? section.title : '';
    return {
      index,
      section: sectionTitle,
      headers: parsed.headers,
      rows: parsed.rows.map((row) => ({
        ...row,
        section: sectionTitle,
        id: storyId(pageTitle, sectionTitle, row.name, row.date)
      }))
    };
  });
  const rows = tables.flatMap((table) => table.rows);
  const sections = headings.map((heading, index) => {
    const next = headings[index + 1];
    const slice = source.slice(heading.end, next ? next.start : source.length);
    const plain = cleanInline(slice.replace(/\{\|[\s\S]*?\|\}/g, ' ')).slice(0, 1500);
    return {
      title: heading.title,
      level: heading.level,
      index,
      kind: META_SECTION.test(heading.title) ? 'meta' : 'content',
      text: plain,
      rows: rows.filter((row) => row.section === heading.title).length
    };
  });
  return { sections, tables, rows, links: wikiLinks(source).slice(0, 40) };
}

function sectionAt(headings, offset) {
  let found = null;
  headings.forEach((heading) => {
    if (heading.start < offset) found = heading;
  });
  return found;
}

function extractTables(source) {
  const tables = [];
  let depth = 0;
  let start = -1;
  const re = /\{\||\|\}/g;
  let match = re.exec(source);
  while (match) {
    if (match[0] === '{|') {
      if (depth === 0) start = match.index;
      depth += 1;
    } else if (depth) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        tables.push({ start, raw: source.slice(start, match.index + 2) });
        start = -1;
      }
    }
    match = re.exec(source);
  }
  return tables;
}

function parseTable(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const grid = [];
  let current = null;
  let cell = null;
  lines.forEach((line) => {
    if (/^\{\|/.test(line) || /^\|\}/.test(line) || /^\|\+/.test(line)) return;
    if (/^\|-/.test(line)) {
      if (current && current.length) grid.push(current);
      current = [];
      cell = null;
      return;
    }
    const headerLine = /^!/.test(line);
    const dataLine = /^\|(?![\}\+\-])/.test(line);
    if (headerLine || dataLine) {
      if (!current) current = [];
      const parts = splitCells(line.replace(/^[!|]/, ''));
      parts.forEach((part) => {
        cell = { header: headerLine, text: part };
        current.push(cell);
      });
      return;
    }
    if (cell) cell.text += `\n${line}`;
  });
  if (current && current.length) grid.push(current);
  let headers = [];
  let startRow = 0;
  if (grid[0] && grid[0].every((item) => item.header)) {
    headers = grid[0].map((item) => cleanInline(item.text));
    startRow = 1;
  }
  const roles = headers.map(columnRole);
  const rows = [];
  for (let i = startRow; i < grid.length; i++) {
    const values = grid[i].map((item) => cleanInline(item.text));
    const row = mapRow(headers, roles, values);
    if (row.name || row.story) rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}

function splitCells(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const text = String(body || '');
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i) || text.startsWith('[[', i)) depth += 1;
    if ((text.startsWith('}}', i) || text.startsWith(']]', i)) && depth) depth -= 1;
    const double = text.startsWith('||', i) || text.startsWith('!!', i);
    if (double && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 2;
      i += 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.map(stripCellAttrs);
}

function stripCellAttrs(cell) {
  const text = String(cell || '').trim();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i) || text.startsWith('[[', i)) depth += 1;
    if ((text.startsWith('}}', i) || text.startsWith(']]', i)) && depth) depth -= 1;
    if (text[i] === '|' && depth === 0) {
      const before = text.slice(0, i);
      if (/=/.test(before) && !before.includes('[')) return text.slice(i + 1).trim();
      return text;
    }
  }
  return text;
}

function columnRole(header) {
  const name = String(header || '');
  if (IMAGE_COL.test(name)) return 'image';
  if (NAME_COL.test(name)) return 'name';
  if (DATE_COL.test(name)) return 'date';
  if (PLACE_COL.test(name)) return 'place';
  if (STORY_COL.test(name)) return 'story';
  return '';
}

function mapRow(headers, roles, values) {
  const row = { name: '', date: '', place: '', story: '', fields: {} };
  values.forEach((value, index) => {
    if (!value) return;
    const header = headers[index] || '';
    const role = roles[index] || (index === 0 && !headers.length ? 'name' : '');
    if (header) row.fields[header] = value;
    if (role === 'image') return;
    if (role && !row[role]) row[role] = value;
    else if (!role && value.length > row.story.length) row.story = value;
  });
  if (!row.name) {
    const first = values.find((value) => value && value.length < 120);
    row.name = first || '';
  }
  return {
    name: row.name.slice(0, 200),
    date: row.date.slice(0, 80),
    place: row.place.slice(0, 120),
    story: row.story.slice(0, 2500),
    fields: row.fields
  };
}

function cleanInline(raw) {
  let text = String(raw || '');
  text = text.replace(/<ref\b[^>]*\/>/gi, ' ');
  let guard = 0;
  while (/<ref\b[^>]*>[\s\S]*?<\/ref>/i.test(text) && guard < 20) {
    text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, ' ');
    guard += 1;
  }
  guard = 0;
  while (/\{\{[^{}]+\}\}/.test(text) && guard < 30) {
    text = text.replace(/\{\{([^{}]+)\}\}/g, (_, inner) => templateValue(inner));
    guard += 1;
  }
  text = text.replace(/\[\[(?:File|Image|Dosya|Dosya):[\s\S]*?\]\]/gi, ' ');
  text = text.replace(/\[\[([^\]|#]+)#([^\]|]+)\|([^\]]+)\]\]/g, '$3');
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]]+)?\]\]/g, '$1');
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/gi, '$1');
  text = text.replace(/\[https?:\/\/[^\]]+\]/gi, ' ');
  text = text.replace(/'{2,}/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function templateValue(inner) {
  const parts = String(inner || '').split('|');
  const name = parts[0].trim().toLowerCase();
  const args = parts.slice(1).map((part) => part.trim()).filter((part) => part && !/^(nowrap|abbr|df|format|sortable)\b/i.test(part));
  const positional = args.filter((part) => !part.includes('='));
  if (name === 'dts' || name === 'date' || name === 'death date and age' || name === 'death date') return positional[positional.length - 1] || '';
  if (name === 'flag' || name === 'flagcountry' || name === 'flagicon') {
    const named = args.find((part) => /^name=/i.test(part));
    if (named) return named.slice(named.indexOf('=') + 1).trim();
    return positional[0] || '';
  }
  if (name === 'sortname') return positional.slice(0, 2).join(' ');
  if (name === 'lang' || name === 'small' || name === 'nowrap') return positional[positional.length - 1] || '';
  if (/^(cite|reflist|efn|sfn|harv|nbsp|center|sort|hs)$/.test(name)) return '';
  if (!args.length && name.length < 40) return parts[0].trim();
  return '';
}

function wikiLinks(source) {
  const links = [];
  source = String(source || '').replace(/\{\|[\s\S]*?\|\}/g, ' ');
  const seen = new Set();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  let match = re.exec(source);
  while (match) {
    const title = match[1].trim();
    if (!/^(File|Image|Category|Dosya|Kategori):/i.test(title)) {
      const label = cleanInline(match[2] || title);
      const key = title.toLowerCase();
      if (label && !seen.has(key)) {
        seen.add(key);
        links.push({ title, label });
      }
    }
    match = re.exec(source);
  }
  return links;
}

function storyId(page, section, name, date) {
  return crypto.createHash('sha1').update([page, section, name, date].join('\n')).digest('hex').slice(0, 16);
}

function readWikiStore(file) {
  const target = file || USED_FILE;
  if (!fs.existsSync(target)) return { stories: [], open: '' };
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    const list = Array.isArray(data) ? data : data.stories;
    return {
      stories: Array.isArray(list) ? list : [],
      open: String((data && data.open) || '').trim().slice(0, 500)
    };
  } catch {
    return { stories: [], open: '' };
  }
}

function writeWikiStore(store, file) {
  const target = file || USED_FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = JSON.stringify({
    open: String((store && store.open) || '').trim().slice(0, 500),
    stories: ((store && store.stories) || []).slice(-MAX_USED)
  }, null, 2);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

function readUsedStories(file) {
  return readWikiStore(file).stories;
}

function readOpenPage(file) {
  return readWikiStore(file).open;
}

function saveOpenPage(query, file) {
  const open = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!open) {
    const error = new Error('Açık kalacak Wikipedia linki gerekli.');
    error.statusCode = 400;
    throw error;
  }
  const store = readWikiStore(file);
  store.open = open;
  writeWikiStore(store, file);
  return { ok: true, open };
}

function writeUsedStories(list, file) {
  const store = readWikiStore(file);
  store.stories = list;
  writeWikiStore(store, file);
}

function saveUsedStory(entry, file) {
  const id = String(entry && entry.id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) {
    const error = new Error('Hikâye kimliği geçersiz.');
    error.statusCode = 400;
    throw error;
  }
  const all = readUsedStories(file);
  const prior = all.find((item) => item && item.id === id) || {};
  const list = all.filter((item) => item && item.id !== id);
  if (entry.remove) {
    writeUsedStories(list, file);
    return { ok: true, removed: true, id, stories: list };
  }
  const title = String(entry.title || entry.name || prior.title || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) {
    const error = new Error('Hikâye başlığı gerekli.');
    error.statusCode = 400;
    throw error;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(entry, key);
  const saved = {
    id,
    title,
    page: String(has('page') ? entry.page : (prior.page || '')).replace(/\s+/g, ' ').trim().slice(0, 300),
    video: has('video') ? Boolean(entry.video) : Boolean(prior.video),
    marked: has('marked') ? Boolean(entry.marked) : (prior.marked == null ? true : Boolean(prior.marked)),
    updated_at: new Date().toISOString()
  };
  if (!saved.video && !saved.marked) {
    writeUsedStories(list, file);
    return { ok: true, removed: true, id, stories: list };
  }
  list.push(saved);
  writeUsedStories(list, file);
  return { ok: true, story: saved, stories: list };
}

module.exports = {
  USED_FILE,
  resolveWikiTarget,
  parseWikitext,
  fetchWikipedia,
  readUsedStories,
  readOpenPage,
  saveOpenPage,
  saveUsedStory,
  storyId
};
