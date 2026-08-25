/**
 * 국어사전 표제어 조회.
 *
 * `npm run setup:dict` 로 받아 둔 목록을 메모리에 올려 두고 0ms 로 확인한다.
 * 목록이 없으면 검사를 건너뛴다 — 사전이 없다고 게임이 안 돌아가면 안 되니까.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORD_FILE = path.join(here, '..', 'data', 'korean-words.txt');

/**
 * 사전에 없지만 게임에서는 인정하고 싶은 말.
 * 표준국어대사전 표제어에는 "방울토마토" 처럼 일상적으로 쓰는 합성어가 빠져 있다.
 * 억울한 탈락이 나올 때마다 여기에 추가하면 된다.
 */
const ALLOW = new Set([
    '방울토마토', '떡꼬치', '순대국밥', '분식집', '반찬가게', '정육점',
    '어묵탕', '핫도그', '아이스크림', '에어컨', '휴대폰', '노트북',
]);

let words = null;   // Set | null(아직 안 읽음) — 파일이 없으면 빈 Set 이 된다
let loadError = null;

function load() {
    if (words) return words;
    try {
        const text = fs.readFileSync(WORD_FILE, 'utf8');
        words = new Set(text.split('\n').map(w => w.trim()).filter(Boolean));
    } catch (e) {
        loadError = e.code === 'ENOENT'
            ? '단어 목록이 없습니다. `npm run setup:dict` 을 실행하면 조어 걸러내기가 켜집니다.'
            : e.message;
        words = new Set();   // 다시 읽으려 시도하지 않는다
    }
    return words;
}

/** 사전이 준비돼 있는가 (없으면 실재성 검사를 건너뛴다) */
export function hasDictionary() {
    return load().size > 0;
}

export function dictionaryStatus() {
    const size = load().size;
    return { ready: size > 0, size, problem: loadError };
}

/**
 * 국어사전에 있는 낱말인가.
 * 사전이 준비돼 있지 않으면 언제나 true — 검사 자체를 하지 않는다.
 */
export function isRealWord(word) {
    const set = load();
    if (set.size === 0) return true;
    const key = String(word ?? '').trim();
    return ALLOW.has(key) || set.has(key);
}
