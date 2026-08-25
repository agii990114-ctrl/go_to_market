/**
 * 단어 생성 전략 비교.
 *
 *   node bench/gen-strategy.js
 *
 * "프롬프트로 생성 품질을 관리할 수 있는가" 를 재는 실험이다.
 * 같은 모델, 같은 주제로 세 가지를 견준다.
 *
 *   A. 지금 방식      — 한 번에 한 단어. 규칙만 길게 적어 둔 프롬프트
 *   B. few-shot      — A + 실제 대화 예시 세 쌍
 *   C. 묶음 생성      — 한 번에 20개를 받아 코드가 사전으로 거른다
 *
 * 재는 것은 "국어사전에 있는 낱말이 몇 개 나왔나" 와 "그 한 개당 몇 초 걸렸나".
 * 게임에서 쓸 수 있는 단어를 얻는 실질 비용이 그거다.
 */
import 'dotenv/config';
import { askJson } from '../server/llm.js';
import { cleanWord, isUsableWord, normalize } from '../server/game.js';
import { isRealWord } from '../server/dictionary.js';
import { modelFor } from '../server/llm.js';

const TOPIC = '시장';
const ROUNDS = 12;      // A, B 는 이만큼 호출한다
const BATCH = 20;       // C 가 한 번에 요청하는 개수

const BASE_RULES = `당신은 한국의 말놀이 '시장에 가면' 게임의 플레이어다.

[규칙]
- 이미 나온 단어 목록에 있는 단어는 절대 쓰지 않는다.
- 주제 그 자체를 단어로 내지 않는다.
- 2~5글자의 일상적인 한국어 명사를 고른다.
- 국어사전에 실려 있는 낱말만 쓴다. 두 낱말을 붙여 새말을 만들지 않는다.
- 서식 기호나 설명을 붙이지 않는다.`;

const WORD_SCHEMA = {
    type: 'object',
    properties: {
        word: { type: 'string', maxLength: 8 },
        exhausted: { type: 'boolean' },
    },
    required: ['word', 'exhausted'],
    additionalProperties: false,
};

const LIST_SCHEMA = {
    type: 'object',
    properties: {
        words: {
            type: 'array',
            minItems: BATCH,
            maxItems: BATCH,
            items: { type: 'string', maxLength: 8 },
        },
    },
    required: ['words'],
    additionalProperties: false,
};

/* B 가 쓰는 예시. 좋은 답이 어떻게 생겼는지 보여 준다. */
const FEW_SHOT = `
[좋은 답과 나쁜 답의 예]

주제 "시장", 이미 나온 단어: 고등어
  좋음: 흥정, 멸치, 저울, 함지박, 리어카, 엿장수
  나쁨: 고등어살(고등어를 품음), 흥정소리(사전에 없음), 시장(주제 그 자체)

주제 "냉장고", 이미 나온 단어: 김치
  좋음: 계란, 우유, 반찬, 성에, 얼음
  나쁨: 김치통(김치를 품음), 냉장고문(주제를 품음), 반찬칸(사전에 없음)

주제 "동물원", 이미 나온 단어: 코끼리
  좋음: 사육사, 우리, 먹이, 원숭이, 매표소
  나쁨: 코끼리코, 동물원길, 사자우리(사전에 없음)

핵심: 국어사전에 실려 있는 낱말만. 낱말을 붙여 지어내지 말 것.`;

async function runSingle(label, system) {
    const used = [];
    let calls = 0;
    let elapsed = 0;
    const rejected = [];

    for (let i = 0; i < ROUNDS; i++) {
        const usedBlock = used.length ? used.join(', ') : '(아직 없음)';
        const rejBlock = rejected.length
            ? `\n이미 퇴짜맞은 후보(다시 쓰지 마세요): ${rejected.slice(-10).join(', ')}`
            : '';
        const t = Date.now();
        let out;
        try {
            out = await askJson({
                role: 'generate',
                maxTokens: 200,
                system,
                user: `주제: "${TOPIC}"\n이미 나온 단어: ${usedBlock}${rejBlock}\n\n새 단어 하나를 내주세요.`,
                schema: WORD_SCHEMA,
            });
        } catch (e) {
            elapsed += Date.now() - t; calls++;
            rejected.push('(오류)');
            continue;
        }
        elapsed += Date.now() - t;
        calls++;

        const word = cleanWord(out.word);
        if (accept(word, used)) used.push(word);
        else rejected.push(word || '(빈 값)');
    }

    return { label, kept: used, calls, elapsed };
}

async function runBatch(label, system) {
    const used = [];
    let calls = 0;
    let elapsed = 0;

    // 12개를 채울 때까지 묶음으로 받는다 (보통 한두 번이면 끝난다)
    while (used.length < ROUNDS && calls < 4) {
        const usedBlock = used.length ? used.join(', ') : '(아직 없음)';
        const t = Date.now();
        let out;
        try {
            out = await askJson({
                role: 'generate',
                maxTokens: 900,
                system,
                user: `주제: "${TOPIC}"\n이미 나온 단어: ${usedBlock}\n\n`
                    + `주제에 어울리는 서로 다른 낱말 ${BATCH}개를 나열해주세요.`,
                schema: LIST_SCHEMA,
            });
        } catch (e) {
            elapsed += Date.now() - t; calls++;
            continue;
        }
        elapsed += Date.now() - t;
        calls++;

        for (const raw of out.words || []) {
            if (used.length >= ROUNDS) break;
            const word = cleanWord(raw);
            if (accept(word, used)) used.push(word);
        }
    }

    return { label, kept: used, calls, elapsed };
}

/** 게임이 실제로 채택할 조건과 똑같이 건다 */
function accept(word, used) {
    if (!isUsableWord(word)) return false;
    if (normalize(word) === normalize(TOPIC)) return false;
    if (used.some(w => normalize(w) === normalize(word))) return false;
    if ([TOPIC, ...used].some(w => normalize(w).length >= 2 && normalize(word).includes(normalize(w)) && normalize(w) !== normalize(word))) return false;
    return isRealWord(word);
}

console.log(`\n  모델 : ${modelFor('generate')} / 주제 : "${TOPIC}" / 목표 : 쓸 만한 단어 ${ROUNDS}개\n`);

const results = [
    await runSingle('A. 지금 방식 (한 개씩)', BASE_RULES),
    await runSingle('B. few-shot 추가', BASE_RULES + '\n' + FEW_SHOT),
    await runBatch('C. 묶음 20개 + 코드 선별', BASE_RULES + '\n' + FEW_SHOT),
];

console.log('  ' + '전략'.padEnd(26) + '쓸만한 단어  호출  총시간   단어당');
console.log('  ' + '-'.repeat(64));
for (const r of results) {
    const per = r.kept.length ? (r.elapsed / r.kept.length / 1000).toFixed(1) + '초' : '—';
    console.log('  ' + r.label.padEnd(24)
        + String(r.kept.length).padStart(6) + '개'
        + String(r.calls).padStart(6)
        + (r.elapsed / 1000).toFixed(1).padStart(8) + '초'
        + per.padStart(9));
}
console.log('');
for (const r of results) console.log(`  ${r.label}\n    ${r.kept.join(', ') || '(없음)'}\n`);
