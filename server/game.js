/**
 * 게임 규칙 중 "AI 없이 코드로 판단해야 하는 것" 과
 * AI 차례의 생성-검수-심판 루프.
 *
 * 중복 판정을 AI 에 맡기면 억울한 패배가 나온다. 여기서 결정론적으로 처리한다.
 */
import { generateWords, inspect, judge } from './agents.js';
import { modelFor, providerFor } from './llm.js';
import { isRealWord } from './dictionary.js';

/**
 * 주제별 단어 풀.
 *
 * 모델에게 단어를 하나씩 "떠올려" 달라고 하면 없는 말을 지어낸다.
 * 여러 개를 한 번에 "나열" 하게 하고 실재어 판별은 코드가 하면, 같은 모델이
 * 훨씬 나은 답을 낸다. 받아 둔 낱말을 여기 쌓아 두면 대부분의 턴에서
 * 생성 호출이 아예 없다.
 *
 * bench/gen-strategy.js 측정 (exaone3.5:7.8b, 주제 "시장", 쓸 만한 단어 12개 기준)
 *   하나씩            : 12번 호출 / 17.9초 / 7개만 건짐
 *   + few-shot        : 12번 호출 / 17.7초 / 10개
 *   묶음 20개 + 코드 선별 : 1번 호출 / 6.9초 / 12개  ← 이 방식
 */
const poolByTopic = new Map();
const BATCH_SIZE = 20;
const MAX_REFILLS = 3;   // 이만큼 새로 받아도 쓸 게 없으면 주제가 바닥난 것으로 본다

function poolFor(topic, lang = 'ko') {
    const key = lang + ':' + normalize(topic);
    if (!poolByTopic.has(key)) poolByTopic.set(key, []);
    return poolByTopic.get(key);
}

/** 풀을 새로 채운다. 이미 걸러진 것은 넣지 않는다. */
async function refillPool(topic, usedWords, log, lang) {
    const pool = poolFor(topic, lang);
    const before = pool.length;

    let result;
    try {
        result = await generateWords(topic, usedWords, BATCH_SIZE, lang);
    } catch (e) {
        log.push({ stage: '생성', word: null, passed: false, reason: e.message });
        return 0;
    }

    for (const raw of result?.words || []) {
        // 영어 생성은 { word, gloss } 로 온다. 한국어는 문자열이다.
        const word = cleanWord(typeof raw === 'string' ? raw : raw?.word);
        const gloss = typeof raw === 'string' ? '' : cleanWord(raw?.gloss);

        // 아이디어가 떨어지면 모델이 "%FISH%", ">>KNIF<<", ".RECORD" 같은
        // 아스키 쓰레기를 섞어 보낸다. 어차피 사전에서 걸리지만, 풀에 들이지 않는다.
        const shape = lang === 'en' ? /^[a-zA-Z][a-zA-Z]{1,15}$/ : /^[가-힣]{2,8}$/;
        if (!shape.test(word)) continue;
        if (!isUsableWord(word)) continue;
        if (pool.some(e => normalize(e.word) === normalize(word))) continue;
        pool.push({ word: lang === 'en' ? word.toLowerCase() : word, gloss });
    }
    return pool.length - before;
}

/** 두 역할이 같은 프로바이더의 같은 모델로 해석되는가 */
function isSameEngine(roleA, roleB) {
    return providerFor(roleA) === providerFor(roleB)
        && modelFor(roleA) === modelFor(roleB);
}

/** 비교용 정규화 — 프런트의 normalize() 와 규칙이 같아야 한다 */
export function normalize(str) {
    return String(str).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 모델이 붙여 보낸 군더더기를 떼어낸다.
 *
 * 로컬 모델은 단어 하나만 내라고 해도 마크다운 강조(**냄새**), 따옴표, 마침표를
 * 자주 붙인다. 이걸 그대로 채택하면 사용자가 암송할 때 별표까지 쳐야 통과하게 된다.
 * 프롬프트로 부탁만 하지 말고 코드에서 확실히 벗겨낸다.
 */
export function cleanWord(raw) {
    return String(raw ?? '')
        .replace(/[*_`~]/g, '')                 // 마크다운 강조 기호
        .replace(/^[-–—\s]+|[-–—\s]+$/g, '')   // 앞뒤 붙임표 ("--소리--" 가 나왔다)
        .replace(/[{}[\]]/g, '')                 // 모델이 흘린 JSON 조각 (실제로 '향신료} }}' 가 나왔다)
        .replace(/^["'“”‘’(\[]+|["'“”‘’)\]]+$/g, '')   // 감싼 따옴표·괄호
        .replace(/[.,!?;:]+$/g, '')             // 끝에 붙은 문장부호
        .replace(/\s+/g, ' ')
        .trim();
}

/** 게임에 쓸 수 있는 모양인지 (한 낱말인지) */
export function isUsableWord(word) {
    return Boolean(word) && !word.includes(' ') && word.length <= 8;
}

export function isDuplicate(word, usedWords) {
    const key = normalize(word);
    return usedWords.some(w => normalize(w) === key);
}

/**
 * 이미 나온 낱말(또는 주제어)을 통째로 품고 있는 말인지.
 *
 * 로컬 모델은 겹치지 않는 단어를 찾기 어려워지면 낱말을 붙여 새말을 지어낸다.
 * "시장꾼", "냄새꾼", "저울소리", "과일상자" 같은 것들인데, 있지도 않은 말을
 * 외우게 하면 기억력 훈련이 안 된다.
 *
 * 모델에게 물어봐도 소용이 없다 — 어휘가 실재하는지 판단하는 능력이 없어서
 * "함바키" 를 사전에 있다고 답한다. 그래서 코드에서 결정론적으로 막는다.
 *
 * 이것만으로 조어를 전부 잡지는 못하지만(앞말이 아직 안 나왔으면 통과된다),
 * "이미 나온 말을 품은 것은 새 단어로 치지 않는다" 는 게임 규칙으로서도 타당하다.
 */
export function containsExistingWord(word, usedWords, topic) {
    const key = normalize(word);
    return [topic, ...usedWords]
        .map(normalize)
        .filter(w => w && w.length >= 2 && w !== key)
        .some(w => key.includes(w));
}

/**
 * AI 차례를 한 번 진행한다.
 *
 * @param {string} topic
 * @param {string[]} usedWords  지금까지 나온 모든 단어 (내 것 + AI 것)
 * @param {boolean} refereeOnAi 검수 통과 후 심판까지 한 번 더 거칠지
 * @returns {{outcome:'ok'|'exhausted', word?:string, attempts:number, log:Array}}
 */
export async function playAiTurn(topic, usedWords, refereeOnAi = true, lang = 'ko') {
    const log = [];
    const pool = poolFor(topic, lang);
    let refills = 0;
    let calls = 0;

    while (true) {
        // 풀이 비었으면 한 번에 여러 개를 받아 채운다
        if (pool.length === 0) {
            if (refills >= MAX_REFILLS) {
                return { outcome: 'exhausted', attempts: calls, log };
            }
            refills++;
            calls++;
            const added = await refillPool(topic, usedWords, log, lang);
            if (added === 0) continue;   // 하나도 못 건졌다 → 다음 회차에서 다시 채우거나 포기
        }

        const picked = pool.shift();
        const word = picked.word;
        const gloss = picked.gloss || '';

        // --- 코드가 내리는 판정. 전부 0ms 이므로 마음껏 거른다. ---

        if (normalize(word) === normalize(topic)) {
            log.push({ stage: '형식', word, passed: false, reason: '주제와 같은 말' });
            continue;
        }
        if (isDuplicate(word, usedWords)) {
            log.push({ stage: '중복', word, passed: false, reason: '이미 나온 단어' });
            continue;
        }
        if (containsExistingWord(word, usedWords, topic)) {
            log.push({ stage: '조어', word, passed: false, reason: '이미 나온 낱말을 품음' });
            continue;
        }
        // 사전 검사는 AI 단어에만 건다. 사람 단어에는 걸지 않는다 —
        // 표제어에 "방울토마토" 같은 일상어가 빠져 있어서 억울한 패배가 나온다.
        if (!isRealWord(word, lang)) {
            log.push({ stage: '사전', word, passed: false, reason: '사전에 없는 말' });
            continue;
        }

        // --- 여기서부터 모델에게 묻는다 ---

        calls++;
        const check = await inspect(topic, word, lang);
        if (!check.valid) {
            log.push({ stage: '검수', word, passed: false, reason: check.reason });
            continue;
        }
        log.push({ stage: '검수', word, passed: true, reason: check.reason });

        // 검수와 심판이 같은 모델이면 답이 결정론적으로 같아진다.
        // 그때 심판은 검증이 아니라 대기 시간일 뿐이라 건너뛴다.
        if (refereeOnAi && !isSameEngine('inspect', 'judge')) {
            calls++;
            const verdict = await judge(topic, word, lang);
            if (!verdict.valid) {
                log.push({ stage: '심판', word, passed: false, reason: verdict.reason });
                continue;
            }
            log.push({ stage: '심판', word, passed: true, reason: verdict.reason });
        }

        return { outcome: 'ok', word, gloss, attempts: calls, log };
    }
}
