/**
 * 주제 검사.
 *
 * 이 게임은 "<주제>에 가면 ~도 있고" 라는 말놀이다. 주제가 장소가 아니면
 * 판정 기준 자체가 흔들린다. 실제로 주제를 "게임" 으로 두었더니 심판이
 * 지어낸 이름("카르네시아")까지 통과시켰다 — 그 단어가 실재하는 게임인지
 * 모델이 판단하지 못하기 때문이다.
 *
 * 그래서 주제를 "안에 무언가가 들어 있는 공간" 으로 묶는다.
 * 그러면 판정이 "그 공간 안에서 볼 수 있나?" 하나로 좁혀지고,
 * 고유명사가 쏟아지는 주제가 애초에 들어오지 않는다.
 *
 * 검사는 두 겹이다.
 *   1) 조어인가  — 코드가 국어사전으로 0ms 에 판단한다.
 *   2) 장소인가  — 모델이 판단한다. 코드로는 알 수 없다.
 */
import { isRealWord } from './dictionary.js';

const MAX_TOKENS = 3;

/** "할머니 댁", "public bath" 처럼 띄어 쓴 주제를 낱말로 쪼갠다 */
export function splitTopic(topic) {
    return String(topic ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * 국어사전에 없는 낱말이 섞여 있는가.
 *
 * 모델이 주제를 추천할 때 "시장과일", "냉장고채소" 처럼 두 낱말을 붙여
 * 지어내는 일이 잦았다. 낱말 단위로 보면 결정론적으로 걸러진다.
 * 사전을 받아 두지 않았으면 isRealWord() 가 언제나 true 라 이 검사는 꺼진다.
 */
export function findCoinedWords(topic, lang = 'ko') {
    return splitTopic(topic).filter(w => !isRealWord(w, lang));
}

/**
 * 모델에게 묻기 전에 코드가 먼저 볼 수 있는 것들.
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkTopicShape(topic, lang = 'ko') {
    const tokens = splitTopic(topic);
    const isEn = (lang === 'en');

    if (tokens.length === 0) {
        return { ok: false, reason: '주제를 입력해주세요.' };
    }
    if (tokens.length > MAX_TOKENS) {
        return { ok: false, reason: '주제는 세 낱말 이내로 짧게 써주세요.' };
    }
    if (topic.length > 24) {
        return { ok: false, reason: '주제는 24자 이내로 써주세요.' };
    }

    const shape = isEn ? /^[a-zA-Z0-9 ]+$/ : /^[가-힣0-9 ]+$/;
    if (!shape.test(topic.trim())) {
        return { ok: false, reason: isEn ? '주제는 영어로 써주세요.' : '주제는 한글로 써주세요.' };
    }

    const coined = findCoinedWords(topic, lang);
    if (coined.length) {
        return {
            ok: false,
            reason: `"${coined.join(', ')}" 은(는) ${isEn ? '영어 사전' : '국어사전'}에 없는 말이에요. `
                + '실제로 쓰는 낱말로 써주세요.',
        };
    }

    return { ok: true };
}
