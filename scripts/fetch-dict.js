/**
 * 한국어 표제어 목록을 받아 게임에서 쓸 형태로 줄인다.
 *
 *   npm run setup:dict
 *
 * 출처 : https://github.com/acidsound/korean_wordlist (국립국어원 표준국어대사전 표제어)
 * 낱말과 품사를 모아 놓은 목록이라 자유롭게 쓸 수 있다.
 *
 * 왜 필요한가 : 로컬 모델은 겹치지 않는 단어를 찾기 어려워지면 낱말을 붙여
 * 새말을 지어낸다("과일상자", "냄새꾼", "함바키"). 모델에게 물어봐야 소용이 없다 —
 * 어휘가 실재하는지 판단하는 능력이 없어서 "함바키"를 사전에 있다고 답한다.
 * 그래서 중복 검사와 같은 자리, 즉 결정론적인 코드에서 막는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/acidsound/korean_wordlist/master/wordslistUnique.txt';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');
const outFile = path.join(dataDir, 'korean-words.txt');

console.log(`  내려받는 중 : ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok) {
    console.error(`  ✖ 받지 못했습니다 (HTTP ${res.status})`);
    process.exit(1);
}
const raw = await res.text();

const all = raw.split(/\r?\n/);

// 한글 음절만으로 된 1~8글자만 남긴다.
//
// 한때 2글자 이상만 받았는데, 그러면 "물", "산", "집", "댁" 같은 한 글자 낱말이
// 통째로 빠진다. 실제로 주제 "할머니 댁" 이 조어로 차단됐다.
// 자모 표제어(ㄱ, ㄴ다고)는 ㄱ-ㅎ 가 가-힣 범위 밖이라 이 정규식에서 이미 걸러진다.
const words = [...new Set(
    all.map(w => w.trim()).filter(w => /^[가-힣]{1,8}$/.test(w))
)].sort();

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(outFile, words.join('\n'));

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`  원본 표제어 : ${all.length.toLocaleString()}개`);
console.log(`  거른 뒤     : ${words.length.toLocaleString()}개 (${mb}MB)`);
console.log(`  저장         : ${path.relative(process.cwd(), outFile)}`);
