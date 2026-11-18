/**
 * Konu ve senaryo iskeleti. Gemini, ElevenLabs ve Pollinations çağırmaz.
 * Kullanım: node documentary-dry-run.js --fixture tests/fixtures/scene-plan.json [--out dosya.json]
 */
const fs = require('fs');
const { loadDocConfig } = require('./documentary-config');

function wordCount(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function dryRunPlan(plan, config) {
  const scenes = Array.isArray(plan && plan.scenes) ? plan.scenes : [];
  const words = scenes.reduce((sum, scene) => sum + wordCount(scene && scene.narration), 0);
  const target = config.word_target;
  return {
    pipeline: config.STORY_PIPELINE,
    layout: config.OUTPUT_LAYOUT,
    stages: ['topic', 'script'],
    live_calls: false,
    scene_count: scenes.length,
    words,
    word_target: target,
    within_accept: words >= target.acceptMin && words <= target.acceptMax
  };
}

function main() {
  const args = process.argv.slice(2);
  const fixtureAt = args.indexOf('--fixture');
  const outAt = args.indexOf('--out');
  const fixture = fixtureAt >= 0 ? args[fixtureAt + 1] : '';
  if (!fixture) {
    console.error('Kullanım: node documentary-dry-run.js --fixture <plan.json> [--out <rapor.json>]');
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const report = dryRunPlan(plan, loadDocConfig());
  const body = JSON.stringify(report, null, 2);
  if (outAt >= 0 && args[outAt + 1]) fs.writeFileSync(args[outAt + 1], body);
  console.log(body);
  if (!report.within_accept) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { dryRunPlan, wordCount };
