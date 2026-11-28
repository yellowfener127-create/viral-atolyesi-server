const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wiki = require('../wikipedia-page');

const SAMPLE = `
== 2000s ==
{| class="wikitable"
|-
! Name of person
! Image
! Date of death
! Country
! Details
|-
! Johnathan Burton
|
| {{dts|nowrap=off|11 August 2000}}
| {{flag|United States}}
| The 19-year-old [[Las Vegas]] resident died of positional asphyxia.<ref>Newsweek</ref>
|-
! [[Armin Meiwes#Bernd Brandes|Bernd Brandes]]
|
| {{dts|nowrap=off|9 March 2001}}
| {{flag|Germany}}
| The 43-year-old engineer was voluntarily slaughtered in [[Rotenburg]].
|}
== References ==
`;

test('a wikipedia title or url becomes an english page', () => {
  assert.deepEqual(wiki.resolveWikiTarget('List_of_unusual_deaths'), {
    lang: 'en',
    title: 'List of unusual deaths'
  });
  assert.deepEqual(wiki.resolveWikiTarget('https://en.wikipedia.org/wiki/List_of_unusual_deaths'), {
    lang: 'en',
    title: 'List of unusual deaths'
  });
  assert.equal(wiki.resolveWikiTarget('https://tr.wikipedia.org/wiki/İstanbul').lang, 'tr');
  assert.throws(() => wiki.resolveWikiTarget('https://example.com/wiki/Nope'), /Wikipedia/);
});

test('a wikitable becomes name, date, place and story rows', () => {
  const page = wiki.parseWikitext(SAMPLE, 'List of unusual deaths in the 21st century');
  assert.equal(page.rows.length, 2);
  assert.equal(page.sections[0].title, '2000s');
  assert.equal(page.sections[0].rows, 2);
  assert.equal(page.sections[1].kind, 'meta');
  const first = page.rows[0];
  assert.equal(first.name, 'Johnathan Burton');
  assert.equal(first.date, '11 August 2000');
  assert.equal(first.place, 'United States');
  assert.match(first.story, /positional asphyxia/);
  assert.equal(first.story.includes('Newsweek'), false);
  assert.equal(page.rows[1].name, 'Bernd Brandes');
  assert.equal(page.rows[1].place, 'Germany');
  assert.match(page.rows[1].story, /Rotenburg/);
  assert.equal(first.id, wiki.storyId('List of unusual deaths in the 21st century', '2000s', first.name, first.date));
});

test('a sortname cell keeps the person and the place', () => {
  const page = wiki.parseWikitext(`
{| class="wikitable"
|-
! Date
! Person(s)
! Missing from
! Circumstances
|-
| 2 February 2000
! scope="row"| {{sortname|Khadzhi-Murat|Yandiev}}
| [[Grozny]], Russia
| Last seen alive on 2 February 2000.
|}
`, 'Missing');
  assert.equal(page.rows[0].name, 'Khadzhi-Murat Yandiev');
  assert.equal(page.rows[0].date, '2 February 2000');
  assert.equal(page.rows[0].place, 'Grozny, Russia');
  assert.match(page.rows[0].story, /Last seen/);
});

test('marked stories stay in the json file', () => {
  const file = path.join(os.tmpdir(), `va-used-${Date.now()}.json`);
  const saved = wiki.saveUsedStory({
    id: 'brandes2001',
    title: 'Bernd Brandes',
    page: 'List of unusual deaths in the 21st century'
  }, file);
  assert.equal(saved.story.video, false);
  const video = wiki.saveUsedStory({
    id: 'brandes2001',
    title: 'Bernd Brandes',
    page: 'List of unusual deaths in the 21st century',
    video: true
  }, file);
  assert.equal(video.stories.length, 1);
  assert.equal(video.stories[0].video, true);
  assert.equal(video.stories[0].marked, true);
  const unmarked = wiki.saveUsedStory({ id: 'brandes2001', title: 'Bernd Brandes', marked: false }, file);
  assert.equal(unmarked.stories[0].video, true);
  assert.equal(unmarked.stories[0].marked, false);
  assert.equal(wiki.saveOpenPage('https://en.wikipedia.org/wiki/List_of_unusual_deaths', file).open, 'https://en.wikipedia.org/wiki/List_of_unusual_deaths');
  const removed = wiki.saveUsedStory({ id: 'brandes2001', remove: true }, file);
  assert.equal(wiki.readOpenPage(file), 'https://en.wikipedia.org/wiki/List_of_unusual_deaths');
  assert.equal(removed.stories.length, 0);
  assert.equal(wiki.readUsedStories(file).length, 0);
  fs.rmSync(file, { force: true });
});

test('a topic search keeps incident stories and drops a bare definition', () => {
  const rows = wiki.rowsFromTopicResults('psychological experiments', [
    {
      title: 'List of social psychology experiments',
      rows: [{
        name: 'Milgram experiment',
        date: '1961',
        place: 'United States',
        story: 'Participants were told to administer electric shocks to a learner.',
        section: 'Obedience',
        id: 'milgram-row'
      }]
    },
    {
      title: 'Stanford prison experiment',
      extract: 'The Stanford prison experiment was a psychological experiment conducted in 1971 at Stanford University. Volunteers were assigned to be guards or prisoners. The planned two-week study was stopped after six days because the guards became abusive and the prisoners became distressed.'
    },
    {
      title: 'Psychology',
      extract: 'Psychology is the scientific study of mind and behavior. It includes many different approaches and fields of research. Researchers observe how people think, feel, and act in ordinary life.'
    },
    {
      title: 'Milgram experiment',
      extract: 'This page may refer to: several different studies.'
    }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Milgram experiment');
  assert.equal(rows[0].id, 'milgram-row');
  assert.equal(rows[1].name, 'Stanford prison experiment');
  assert.match(rows[1].story, /1971/);
  assert.equal(rows[1].section, 'psychological experiments');
  assert.equal(wiki.storyFromArticle('Psychology', 'Psychology is the scientific study of mind and behavior. It includes many different approaches and fields of research across ordinary life and learning.', 'psychological experiments'), null);
});
