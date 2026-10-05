const fs = require('fs');
const base = 'C:/Users/OULIHONG1999/XiaomiMiMoProjects/2026-09-26/esp32-web/';

// ① useFirmwareWorkspace：loadedMeta（版本时间/类型/说明/chipFamily）
{
  const p = base + 'src/composables/useFirmwareWorkspace.ts';
  let t = fs.readFileSync(p, 'utf8');
  const o1 = '    loadedRelease: null as string | null,';
  const n1 = [
    '    loadedRelease: null as string | null,',
    '    /** 载入版本元信息（面包屑下的来源信息栏：时间/类型/说明/chipFamily） */',
    '    loadedMeta: null as',
    '      | { id: string; type: string; createdAt: string; note?: string; chipFamily?: string }',
    '      | null,',
  ].join('\n');
  if (!t.includes(o1)) { console.error('ws state MISS'); process.exit(1); }
  t = t.replace(o1, n1);

  const o2 = '      state.loadedRelease = rel.id';
  const n2 = [
    '      state.loadedRelease = rel.id',
    '      state.loadedMeta = {',
    '        id: rel.id,',
    '        type: rel.type,',
    '        createdAt: rel.createdAt,',
    '        note: rel.note,',
    '        chipFamily: rel.chipFamily,',
    '      }',
  ].join('\n');
  if (!t.includes(o2)) { console.error('ws load MISS'); process.exit(1); }
  t = t.replace(o2, n2);

  // manual / reset 清空
  t = t.replace('    state.from = \'manual\'', '    state.loadedMeta = null\n    state.from = \'manual\'');
  t = t.replace('    state.from = null', '    state.loadedMeta = null\n    state.from = null');
  fs.writeFileSync(p, t);
  console.log('workspace OK');
}

// ② FirmwarePanel：面包屑下加来源信息栏
{
  const p = base + 'src/components/FirmwarePanel.vue';
  let t = fs.readFileSync(p, 'utf8');
  const anchor = '    <h2 class="fw__title">烧录清单</h2>';
  const strip = [
    '    <div v-if="ws.state.loadedMeta" class="fw__meta">',
    '      <span class="fw__meta-item"><i>来源</i>{{ ws.state.loadedProject }}</span>',
    '      <span class="fw__meta-item"><i>版本</i><code>{{ ws.state.loadedMeta.id }}</code></span>',
    '      <span',
    '        class="fw__meta-badge"',
    '        :class="ws.state.loadedMeta.type === \'release\' ? \'fw__meta-badge--rel\' : \'\'"',
    '      >',
    '        {{ ws.state.loadedMeta.type === \'release\' ? \'★ 发布版\' : \'快照\' }}',
    '      </span>',
    '      <span class="fw__meta-item"><i>创建于</i>{{ fmtStamp(ws.state.loadedMeta.createdAt) }}</span>',
    '      <span v-if="ws.state.loadedMeta.chipFamily" class="fw__meta-item"><i>固件芯片</i>{{ ws.state.loadedMeta.chipFamily }}</span>',
    '      <span v-if="ws.state.loadedMeta.note" class="fw__meta-item fw__meta-note"><i>说明</i>{{ ws.state.loadedMeta.note }}</span>',
    '    </div>',
    '',
  ].join('\n');
  if (!t.includes(anchor)) { console.error('fw anchor MISS'); process.exit(1); }
  t = t.replace(anchor, strip + anchor);

  // fmtStamp 工具（ISO → YYYY-MM-DD HH:mm:ss）
  const fn = [
    '',
    '/** ISO 时间 → 可读时间戳（含秒） */',
    'function fmtStamp(iso: string): string {',
    '  const d = new Date(iso)',
    '  if (Number.isNaN(d.getTime())) return iso',
    '  const pz = (n: number) => String(n).padStart(2, \'0\')',
    '  return `${d.getFullYear()}-${pz(d.getMonth() + 1)}-${pz(d.getDate())} ${pz(d.getHours())}:${pz(d.getMinutes())}:${pz(d.getSeconds())}`',
    '}',
  ].join('\n');
  const i2 = t.indexOf('function hex(');
  if (i2 < 0) { console.error('hex MISS'); process.exit(1); }
  t = t.slice(0, i2) + fn + '\n\n' + t.slice(i2);

  // 样式
  const st = '.fw__loading {';
  const stAdd = [
    '.fw__meta {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px 16px;',
    '  flex-wrap: wrap;',
    '  background: color-mix(in srgb, var(--accent) 7%, var(--panel));',
    '  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));',
    '  border-radius: 6px;',
    '  padding: 8px 12px;',
    '  font-size: 12.5px;',
    '}',
    '.fw__meta-item i {',
    '  font-style: normal;',
    '  color: var(--muted);',
    '  font-size: 10.5px;',
    '  letter-spacing: 0.06em;',
    '  margin-right: 6px;',
    '}',
    '.fw__meta-item code {',
    '  font-family: ui-monospace, monospace;',
    '  color: var(--accent);',
    '}',
    '.fw__meta-badge {',
    '  font-size: 11px;',
    '  border: 1px solid var(--border);',
    '  border-radius: 999px;',
    '  padding: 1px 9px;',
    '  color: var(--muted);',
    '}',
    '.fw__meta-badge--rel {',
    '  color: var(--accent);',
    '  border-color: color-mix(in srgb, var(--accent) 50%, transparent);',
    '  background: color-mix(in srgb, var(--accent) 12%, transparent);',
    '}',
    '.fw__meta-note {',
    '  flex-basis: 100%;',
    '  line-height: 1.6;',
    '}',
    '',
  ].join('\n');
  if (!t.includes(st)) { console.error('style MISS'); process.exit(1); }
  t = t.replace(st, stAdd + st);
  fs.writeFileSync(p, t);
  console.log('fw OK');
}
console.log('ALL DONE');
