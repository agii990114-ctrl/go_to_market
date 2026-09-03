/**
 * 생성 프롬프트의 틀을 바꾸면 적절성이 오르는가.
 *
 *   node bench/gen-framing.js
 *
 * 지금은 "장소에 어울리는 낱말을 나열하라" 고 시킨다.
 * 대신 게임 문장을 그대로 주고 빈칸을 채우게 하면 어떨까 —
 * "시장에 가면 OO 이 있다" 의 OO 에 들어갈 말.
 *
 * 이 틀은 심판이 쓰는 시험과 같다(판정 기준 2번). 생성과 판정이 같은 틀을 쓰면
 * 생성 단계에서 미리 걸러지는 효과가 있을 수 있다.
 *
 * 재는 것은 "생성한 낱말 중 실제로 채택될 비율" 이다.
 * 코드 관문(사전·형식)과 검수 AI 를 모두 통과해야 채택이다.
 */
import 'dotenv/config';
import { askJson } from '../server/llm.js';
import { inspect } from '../server/agents.js';
import { cleanWord, isUsableWord, normalize } from '../server/game.js';
import { isRealWord } from '../server/dictionary.js';
import { clearVerdictCache } from '../server/verdict-cache.js';

const COUNT = 15;

const TOPICS = [
    { topic: '시장', lang: 'ko' },
    { topic: '목욕탕', lang: 'ko' },
    { topic: '냉장고', lang: 'ko' },
    { topic: 'market', lang: 'en' },
    { topic: 'bathhouse', lang: 'en' },
];

const LIST_SCHEMA = {
    type: 'object',
    properties: {
        words: {
            type: 'array',
            minItems: 5,
            maxItems: 30,
            items: { type: 'string', maxLength: 16 },
        },
    },
    required: ['words'],
    additionalProperties: false,
};

const RULES_KO = `[규칙]
- 주제 그 자체를 내지 않는다.
- 사람이 듣고 바로 외울 수 있는, 2~5글자의 일상적인 한국어 명사를 고른다.
- **국어사전에 실려 있는 낱말만 쓴다. 두 낱말을 붙여 새말을 만들지 않는다.**
- 서식 기호나 설명을 붙이지 않는다. 낱말만 적는다.
- 뻔한 것과 덜 뻔한 것을 섞는다.`;

const RULES_EN = `[Rules]
- Never use the topic itself.
- Everyday English nouns a person can memorise. One word, lowercase.
- **Only words an English dictionary would list. Never glue two words together.**
- No formatting, no quotes, no explanations.
- Mix obvious ones with less obvious ones.`;

/* A. 지금 방식 — "어울리는 낱말을 나열하라" */
function listing(topic, lang) {
    const ko = lang === 'ko';
    return {
        system: ko
            ? `당신은 한국의 말놀이 '시장에 가면' 게임의 플레이어다.\n장소에 어울리는 낱말을 여러 개 나열한다.\n\n${RULES_KO}`
            : `You are a player of the word game "When I go to the market".\nList words that fit the place.\n\n${RULES_EN}`,
        user: ko
            ? `주제: "${topic}"\n\n서로 다른 낱말 ${COUNT}개를 나열해주세요.`
            : `Topic: "${topic}"\n\nList ${COUNT} different words.`,
    };
}

/* B. 문장 채우기 — 게임 문장의 빈칸을 채우게 한다 */
function filling(topic, lang) {
    const ko = lang === 'ko';
    return {
        system: ko
            ? `당신은 한국의 말놀이 '시장에 가면' 게임의 플레이어다.\n`
              + `"${topic}에 가면 OO 이(가) 있다" 라는 문장의 OO 을 채운다.\n\n`
              + `그 문장을 소리 내어 읽었을 때 한국어 화자가 고개를 끄덕일 낱말만 고른다.\n`
              + `"${topic}에 가면 OO 이(가) 있다" 가 어색하면 그 낱말은 답이 아니다.\n\n${RULES_KO}`
            : `You are a player of the word game "When I go to the market".\n`
              + `Fill in the blank: "At the ${topic} there is ___."\n\n`
              + `Only choose words that make that sentence sound natural to say out loud.\n`
              + `If "At the ${topic} there is ___" sounds odd, it is not an answer.\n\n${RULES_EN}`,
        user: ko
            ? `"${topic}에 가면 OO 이(가) 있다"\n\nOO 에 들어갈 서로 다른 낱말 ${COUNT}개를 나열해주세요.`
            : `"At the ${topic} there is ___."\n\nList ${COUNT} different words for the blank.`,
    };
}

/** 생성한 낱말이 실제로 채택될지 게임과 같은 관문으로 확인한다 */
async function evaluate(topic, lang, build) {
    const { system, user } = build(topic, lang);

    const t = Date.now();
    let out;
    try {
        out = await askJson({ role: 'generate', maxTokens: 900, system, user, schema: LIST_SCHEMA });
    } catch (e) {
        return { got: 0, shaped: 0, accepted: 0, ms: Date.now() - t, words: [], error: e.message };
    }
    const ms = Date.now() - t;

    const raw = out?.words || [];
    const shape = lang === 'en' ? /^[a-zA-Z]{2,16}$/ : /^[가-힣]{2,8}$/;

    // 코드 관문 : 형식 → 주제 반복 → 사전
    const passedCode = [];
    for (const item of raw) {
        const w = cleanWord(item);
        if (!shape.test(w) || !isUsableWord(w)) continue;
        if (normalize(w) === normalize(topic)) continue;
        if (passedCode.some(p => normalize(p) === normalize(w))) continue;
        if (!isRealWord(w, lang)) continue;
        passedCode.push(lang === 'en' ? w.toLowerCase() : w);
    }

    // 검수 AI
    const accepted = [];
    for (const w of passedCode) {
        const v = await inspect(topic, w, lang);
        if (v.valid) accepted.push(w);
    }

    return { got: raw.length, shaped: passedCode.length, accepted: accepted.length, ms, words: accepted };
}

console.log(`\n  주제마다 ${COUNT}개씩 생성해 실제 관문을 통과시킨다\n`);

const totals = { A: { got: 0, shaped: 0, accepted: 0, ms: 0 }, B: { got: 0, shaped: 0, accepted: 0, ms: 0 } };

for (const { topic, lang } of TOPICS) {
    console.log(`  [${lang}] ${topic}`);
    for (const [key, label, build] of [['A', '나열하라  ', listing], ['B', '문장 채우기', filling]]) {
        clearVerdictCache();
        const r = await evaluate(topic, lang, build);
        totals[key].got += r.got;
        totals[key].shaped += r.shaped;
        totals[key].accepted += r.accepted;
        totals[key].ms += r.ms;
        console.log(`    ${label}  받음 ${String(r.got).padStart(2)} → 코드통과 ${String(r.shaped).padStart(2)}`
            + ` → 채택 ${String(r.accepted).padStart(2)}  (${(r.ms / 1000).toFixed(1)}초)`);
        console.log(`                ${r.words.join(', ') || '(없음)'}`);
    }
    console.log('');
}

console.log('  ' + '방식'.padEnd(16) + '받음   코드통과   최종채택   채택률   생성시간');
console.log('  ' + '-'.repeat(64));
for (const [key, label] of [['A', 'A 나열하라'], ['B', 'B 문장 채우기']]) {
    const t = totals[key];
    console.log('  ' + label.padEnd(15)
        + String(t.got).padStart(4) + String(t.shaped).padStart(9) + String(t.accepted).padStart(11)
        + (Math.round((t.accepted / Math.max(t.got, 1)) * 100) + '%').padStart(9)
        + ((t.ms / 1000).toFixed(1) + '초').padStart(10));
}
console.log('');
