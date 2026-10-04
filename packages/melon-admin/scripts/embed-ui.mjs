// 把 src/ui.html 嵌进 src/ui.ts（页面随包发布，不依赖宿主提供静态文件）。改了 ui.html 跑一下；测试会核对两边一致。
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
writeFileSync(new URL('../src/ui.ts', import.meta.url),
  `// 由 scripts/embed-ui.mjs 从 ui.html 生成，不要手改。\nexport const ADMIN_HTML: string = ${JSON.stringify(html)};\n`);
