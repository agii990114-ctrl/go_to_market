/**
 * 사전 표제어 조회.
 *
 * `npm run setup:dict` 로 받아 둔 목록을 메모리에 올려 두고 0ms 로 확인한다.
 * 목록이 없으면 검사를 건너뛴다 — 사전이 없다고 게임이 안 돌아가면 안 되니까.
 *
 * 이게 필요한 이유 : 모델은 어휘가 실재하는지 판단하지 못한다.
 * "함바키" 가 표준국어대사전에 있느냐고 단독으로 물어도 있다고 답한다.
 * 그래서 그 판단만은 파일 조회로 옮겼다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

const FILES = { ko: 'korean-words.txt', en: 'english-words.txt' };

/**
 * 사전에 없지만 게임에서는 인정하고 싶은 말.
 * 표제어 목록에는 "방울토마토" 처럼 일상적으로 쓰는 합성어가 빠져 있다.
 * 억울한 탈락이 나올 때마다 여기에 추가하면 된다.
 */
const ALLOW = {
    ko: new Set([
        '방울토마토', '떡꼬치', '순대국밥', '분식집', '반찬가게', '정육점',
        '어묵탕', '핫도그', '아이스크림', '에어컨', '휴대폰', '노트북',
    ]),
    en: new Set([
        'shampoo', 'hairdryer', 'smartphone', 'laptop', 'wifi',
    ]),
};

const loaded = new Map();   // lang -> Set
const problems = new Map(); // lang -> string

function load(lang) {
    if (loaded.has(lang)) return loaded.get(lang);

    let words = new Set();
    try {
        const text = fs.readFileSync(path.join(dataDir, FILES[lang]), 'utf8');
        // 파일이 CRLF 로 저장돼 있어도 조회가 빗나가지 않도록 양끝을 다듬는다
        words = new Set(text.split(/\r?\n/).map(w => w.trim()).filter(Boolean));
    } catch (e) {
        problems.set(lang, e.code === 'ENOENT'
            ? `${lang} 단어 목록이 없습니다. \`npm run setup:dict\` 을 실행하면 조어 걸러내기가 켜집니다.`
            : e.message);
    }
    loaded.set(lang, words);   // 실패해도 빈 Set 을 캐시해 다시 읽지 않는다
    return words;
}

/** 비교용 정규화 — 영어는 대소문자를 가리지 않는다 */
function keyOf(word, lang) {
    const w = String(word ?? '').trim();
    return lang === 'en' ? w.toLowerCase() : w;
}

export function dictionaryStatus(lang = 'ko') {
    const size = load(lang).size;
    return { lang, ready: size > 0, size, problem: problems.get(lang) || null };
}

/**
 * 사전에 있는 낱말인가.
 * 사전이 준비돼 있지 않으면 언제나 true — 검사 자체를 하지 않는다.
 */
export function isRealWord(word, lang = 'ko') {
    const set = load(lang);
    if (set.size === 0) return true;
    const key = keyOf(word, lang);
    return (ALLOW[lang] && ALLOW[lang].has(key)) || set.has(key);
}
