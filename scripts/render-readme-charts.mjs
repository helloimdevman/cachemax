import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { summarize, tokenTotals } from './summarize-validation.mjs';

const root = new URL('../', import.meta.url);
const report = JSON.parse(readFileSync(new URL('docs/idle-sweep-2026-09-29.json', root), 'utf8'));
const hosts = [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok Build']];
const minutes = [5, 10, 15, 30, 60, 120];
const summaries = report.controlled.map(study => summarize(study, study.study));
const invalid = report.controlled.flatMap(study => study.results.filter(pair => !pair.valid)
  .map(pair => `${study.host}:${study.idleMs / 60000}:${pair.trial}`));
// Review the paused-result annotation if the source or study protocol changes.
assert.equal(report.protocol.date, '2026-09-29');
assert.deepEqual(invalid, ['claude:120:0', 'claude:120:1']);
assert.equal(summaries.flatMap(study => study.pairs).length, 34);
assert.ok(report.controlled.every(study => study.intervalMs === 180000 && study.results.length === 2));

const number = (value, digits = 1) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const range = (values, digits = 1) => {
  assert.ok(values.length && values.every(Number.isFinite), 'Missing chart measurement');
  const low = number(Math.min(...values), digits), high = number(Math.max(...values), digits);
  return low === high ? low : `${low}–${high}`;
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const text = (x, y, value, size = 14, cls = '', anchor = 'start') =>
  `<text x="${x}" y="${y}" font-size="${size}" class="${cls}" text-anchor="${anchor}">${escape(value)}</text>`;
const labels = {
  en: {
    title: 'Cache on return · usage to keep it warm',
    subtitle: '2026-09-29 · 3-minute interval · two paired runs per host and duration',
    top: 'Top: without cachemax', bottom: 'Bottom: with cachemax', scale: 'Each bar: 0–100%',
    usage: 'Added usage', away: ['5 min', '10 min', '15 min', '30 min', '1 h', '2 h'],
    cost: 'CLI $ estimate', input: 'Input tokens', paused: 'Paused',
  },
  ko: {
    title: '복귀 시 캐시 읽기 · 유지에 든 추가 사용량',
    subtitle: '2026-09-29 · 3분 간격 · 호스트·시간별 2쌍 비교',
    top: '위: cachemax 미사용', bottom: '아래: cachemax 사용', scale: '막대마다 0–100%',
    usage: '추가 사용량', away: ['5분', '10분', '15분', '30분', '1시간', '2시간'],
    cost: 'CLI 달러 추정치', input: '입력 토큰', paused: '중단',
  },
};

function render(lang) {
  const l = labels[lang];
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 454" width="960" height="454" role="img" aria-labelledby="title desc" xml:lang="${lang}">
<title id="title">${escape(l.title)}</title>
<desc id="desc">${escape(`${l.subtitle}. ${l.top}. ${l.bottom}.`)}</desc>
<!-- Generated from docs/idle-sweep-2026-09-29.json by scripts/render-readme-charts.mjs. -->
<style>
text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;fill:#1f2328;font-variant-numeric:tabular-nums}
.muted{fill:#59636e}.bold{font-weight:600}.rule{stroke:#d1d9e0;stroke-width:1}
.track{fill:#d1d9e0;fill-opacity:.35}.off{fill:#717b86}.on{fill:#0969da}.paused{fill:#9a6700}
@media(prefers-color-scheme:dark){text{fill:#f0f6fc}.muted{fill:#9198a1}.rule{stroke:#3d444d}.track{fill:#656c76}.off{fill:#9198a1}.on{fill:#58a6ff}.paused{fill:#d29922}}
</style>`];
  svg.push(text(20, 29, l.title, 23, 'bold'), text(20, 53, l.subtitle, 14, 'muted'));
  svg.push(text(20, 90, l.usage, 14, 'bold'));
  svg.push('<rect x="224" y="77" width="16" height="5" class="off"/>', text(248, 84, l.top, 13));
  svg.push('<rect x="464" y="77" width="16" height="5" class="on"/>', text(488, 84, l.bottom, 13));
  svg.push(text(940, 84, l.scale, 13, 'muted', 'end'));
  l.away.forEach((label, i) => svg.push(text(272 + i * 116, 108, label, 14, 'bold', 'middle')));
  hosts.forEach(([host, name], h) => {
    const y = 140 + h * 110;
    const pairs = summaries.filter(study => study.host === host).flatMap(study => study.pairs);
    const values = pairs.map(pair => host === 'codex' ? pair.postSeedInputRatio : pair.reportedCostChangePercent);
    const usage = host === 'codex' ? `${range(values)}×` : `+${range(values, 0)}%`;
    svg.push(text(20, y, name, 18, 'bold'), text(20, y + 25, host === 'codex' ? l.input : l.cost, 13, 'muted'));
    svg.push(text(20, y + 52, usage, 23, 'bold'));
    minutes.forEach((minute, i) => {
      const study = report.controlled.find(study => study.host === host && study.idleMs === minute * 60000);
      assert.ok(study, `Missing ${host} ${minute}m condition`);
      const paused = study.results.some(pair => !pair.valid);
      ['control', 'keeper'].forEach((arm, a) => {
        const rates = study.results.map(pair => tokenTotals(host, [pair[arm].nextUserUsage]).weightedCacheShare);
        assert.ok(rates.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 1), 'Invalid cache share');
        const x = 224 + i * 116, rowY = y + a * 36;
        const cls = paused ? 'paused' : a ? 'on' : 'off';
        const low = Math.min(...rates) * 96, high = Math.max(...rates) * 96;
        svg.push(`<g><title>${escape(`${name} · ${l.away[i]} · ${a ? l.bottom : l.top}: ${range(rates.map(rate => rate * 100))}%${paused ? ` · ${l.paused}` : ''}`)}</title>`);
        svg.push(text(x + 48, rowY, `${range(rates.map(rate => rate * 100))}%`, 14, paused ? 'paused' : '', 'middle'));
        svg.push(`<rect x="${x}" y="${rowY + 8}" width="96" height="5" class="track"/>
<rect x="${x}" y="${rowY + 8}" width="${low.toFixed(3)}" height="5" class="${cls}"/>
<rect x="${(x + low).toFixed(3)}" y="${rowY + 8}" width="${(high - low).toFixed(3)}" height="5" class="${cls}" opacity=".4"/></g>`);
      });
      if (paused) svg.push(text(272 + i * 116, y + 65, l.paused, 12, 'paused', 'middle'));
    });
    svg.push(`<line x1="20" x2="940" y1="${y + 80}" y2="${y + 80}" class="rule"/>`);
  });
  svg.push('</svg>');
  return svg.join('\n') + '\n';
}

assert.ok(process.argv.slice(2).every(arg => arg === '--check'), 'Usage: node scripts/render-readme-charts.mjs [--check]');
for (const lang of Object.keys(labels)) {
  const file = new URL(`docs/assets/cache-retention${lang === 'en' ? '' : '.ko'}.svg`, root);
  const svg = render(lang);
  if (process.argv.includes('--check')) assert.equal(readFileSync(file, 'utf8'), svg, `Stale ${lang} chart; run node scripts/render-readme-charts.mjs`);
  else writeFileSync(file, svg);
}
console.log(`README charts ${process.argv.includes('--check') ? 'verified' : 'updated'} from 34 completed pairs and 2 paused observations.`);
