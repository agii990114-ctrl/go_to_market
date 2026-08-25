/**
 * 위키백과 문서 제목 목록을 받는다. bench/rag-vs-lookup.js 실험 전용이다.
 *
 *   node scripts/fetch-wiki-titles.js
 *
 * 게임 본체는 이 파일을 쓰지 않는다.
 * 고유명사 판정을 어떻게 고칠지 재본 적이 있어서 그 실험을 재현할 수 있게 남겨 둔다.
 * 결론은 "넣지 않는다" 였다 — 자세한 내용은 README 의 고유명사 항목 참고.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://dumps.wikimedia.org/kowiki/latest/kowiki-latest-all-titles-in-ns0.gz';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');
const tmpFile = path.join(dataDir, '_titles.gz');
const outFile = path.join(dataDir, 'wiki-titles.txt');

fs.mkdirSync(dataDir, { recursive: true });

console.log(`  내려받는 중 : ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok) {
    console.error(`  ✖ 받지 못했습니다 (HTTP ${res.status})`);
    process.exit(1);
}
await pipeline(res.body, fs.createWriteStream(tmpFile));

const raw = zlib.gunzipSync(fs.readFileSync(tmpFile)).toString('utf8');
fs.unlinkSync(tmpFile);

const titles = [...new Set(
    raw.split(/\r?\n/)
        .map(t => t.trim().replace(/_/g, ' ').trim())
        // 동음이의 괄호가 붙은 문서는 게임에서 쓸 일이 없다
        .filter(t => t && t !== 'page_title' && t.length >= 2 && t.length <= 20 && !t.includes('('))
)].sort();

// 줄바꿈을 LF 로 고정한다. CRLF 로 저장되면 읽는 쪽에서 조회가 전부 빗나간다.
fs.writeFileSync(outFile, titles.join('\n'), 'utf8');

console.log(`  제목 : ${titles.length.toLocaleString()}개`);
console.log(`  저장 : ${path.relative(process.cwd(), outFile)} `
    + `(${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)}MB)`);
