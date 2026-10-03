const fs = require('fs');
const base = 'C:/Users/OULIHONG1999/XiaomiMiMoProjects/2026-09-26/esp32-web/';
const p = base + 'src/App.vue';
let t = fs.readFileSync(p, 'utf8');

function cut(startMarker, endMarker, label) {
  const s = t.indexOf(startMarker);
  if (s < 0) { console.error(label + ' start MISS: ' + startMarker.slice(0, 20)); process.exit(1); }
  const e = t.indexOf(endMarker, s);
  if (e < 0) { console.error(label + ' end MISS'); process.exit(1); }
  t = t.slice(0, s) + t.slice(e);
  console.log(label + ' cut');
}

// 2) hasNewRelease + activityItems + activityEndItems + activeActivity
cut('// ---- IDE 注册表', 'const workTabs', 'activity registry');

// 3) onActivity 整函数
cut('function onActivity(id: string): void {', '// ---- 底部面板', 'onActivity');

// 4) 模板 ActivityBar 块
cut('    <ActivityBar', '    />\n\n', 'ActivityBar tag');
if (t.includes('<ActivityBar')) { console.error('ActivityBar leftover'); process.exit(1); }

// 5) CSS 网格两列
t = t.replace('grid-template-columns: 48px var(--sb-w, 250px) minmax(0, 1fr);', 'grid-template-columns: var(--sb-w, 250px) minmax(0, 1fr);');
t = t.replace('.ide > :first-child,\n.ide > .sb {', '.ide > .sb {');
t = t.replace('.ide__center {\n  grid-column: 3;', '.ide__center {\n  grid-column: 2;');

// 6) 媒体查询
t = t.replace('    grid-template-rows: auto auto minmax(0, 1fr) auto 26px;', '    grid-template-rows: auto minmax(0, 1fr) auto 26px;');
t = t.replace('  .ide > :first-child {\n    display: none;\n  }\n', '');
t = t.replace('.ide > .sb {\n    grid-row: 2;', '.ide > .sb {\n    grid-row: 1;');
t = t.replace('.ide__center {\n    grid-column: 1;\n    grid-row: 3;', '.ide__center {\n    grid-column: 1;\n    grid-row: 2;');
t = t.replace('.ide .bp {\n    grid-column: 1;\n    grid-row: 4;', '.ide .bp {\n    grid-column: 1;\n    grid-row: 3;');
t = t.replace('.ide .st {\n    grid-column: 1;\n    grid-row: 5;', '.ide .st {\n    grid-column: 1;\n    grid-row: 4;');

// 7) 子组件列宽
{
  const bp = base + 'src/components/ide/BottomPanel.vue';
  let b = fs.readFileSync(bp, 'utf8');
  b = b.replace('.bp {\n  grid-column: 3;', '.bp {\n  grid-column: 2;');
  fs.writeFileSync(bp, b);
  console.log('BottomPanel col OK');
}
{
  const st = base + 'src/components/ide/StatusBar.vue';
  let s = fs.readFileSync(st, 'utf8');
  s = s.replace('.st {\n  grid-column: 1 / 4;', '.st {\n  grid-column: 1 / 3;');
  fs.writeFileSync(st, s);
  console.log('StatusBar col OK');
}

fs.writeFileSync(p, t);
console.log('App.vue OK');
