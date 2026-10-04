const fs = require('fs');
const base = 'C:/Users/OULIHONG1999/XiaomiMiMoProjects/2026-09-26/esp32-web/';

// ① tools/publish/lib.js：release id 加秒
{
  const p = base + 'tools/publish/lib.js';
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace(
    'YYYYMMDD-HHmm-<commit短哈希|随机4hex>（FIRMWARE-REGISTRY §4.1）',
    'YYYYMMDD-HHmmss-<commit短哈希|随机4hex>（时间到秒，突出可读时间）',
  );
  const before = t;
  t = t.replace(/pad\(d\.getMinutes\(\)\)`/, 'pad(d.getMinutes())${pad(d.getSeconds())}`');
  if (t === before) { console.error('lib seconds MISS'); process.exit(1); }
  fs.writeFileSync(p, t);
  console.log('lib OK');
}

// ② tests/publish-cli.test.js：正则与用例名同步
{
  const p = base + 'tests/publish-cli.test.js';
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace('releaseId 形如 YYYYMMDD-HHmm-xxxx', 'releaseId 形如 YYYYMMDD-HHmmss-xxxx');
  t = t.replace('expect(releaseId()).toMatch(/^\\d{8}-\\d{4}-[0-9a-f]{4,}$/)', 'expect(releaseId()).toMatch(/^\\d{8}-\\d{6}-[0-9a-f]{4,}$/)');
  fs.writeFileSync(p, t);
  console.log('test OK');
}
