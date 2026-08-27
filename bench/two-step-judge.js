/**
 * 판정을 두 단계로 나누면 나아지는가.
 *
 *   node bench/two-step-judge.js
 *
 * 지금 심판은 "모르는 단어" 를 관대함 규칙에 기대어 통과시킨다.
 * 주제 "목욕탕" 에 "옹심이" 가 통과했는데, 사유가 "관련있어 보인다" 로 텅 비어 있었다.
 * 모델에게 옹심이가 뭐냐고 따로 물으면 "전통 인형극" 이라고 지어낸다. 모르는 것이다.
 *
 * "애매하다" 와 "모른다" 는 다르다.
 *   시장 / 노트북   — 알지만 경계에 있다 → 통과가 맞다
 *   목욕탕 / 옹심이 — 뭔지 모른다        → 통과할 근거가 없다
 *
 * 그래서 "이게 무엇인가" 를 먼저 답하게 하고, 그 답을 근거로 판정해 본다.
 * 위험도 같이 잰다 — 모델이 정체를 잘못 말하면(옹심이 → 인형극) 오히려
 * 확신을 갖고 틀릴 수 있다.
 */
import 'dotenv/config';
import { judge } from '../server/agents.js';
import { askJson } from '../server/llm.js';
import { clearVerdictCache } from '../server/verdict-cache.js';

/* 정답이 분명한 케이스 */
const CASES = [
    // 목욕탕에 있는 것 — 통과해야 한다
    ['목욕탕', '비누', true], ['목욕탕', '거울', true], ['목욕탕', '때수건', true],
    ['목욕탕', '수건', true], ['목욕탕', '탕', true], ['목욕탕', '온수', true],
    // 목욕탕에 없는 것 — 탈락해야 한다
    ['목욕탕', '옹심이', false], ['목욕탕', '수제비', false], ['목욕탕', '호랑이', false],
    ['목욕탕', '미적분', false],
    // 흔치 않은 낱말이지만 그 자리에 있는 것 — 통과해야 한다.
    // 두 단계로 나눴을 때 "모른다" 를 핑계로 이것들까지 죽이면 안 된다.
    ['시장', '함지박', true], ['시장', '엿장수', true], ['시장', '좌판', true],
    ['부엌', '조리', true], ['부엌', '주걱', true],
    // 다른 주제의 낯선 음식 — 탈락해야 한다
    ['도서관', '옹심이', false], ['놀이터', '수제비', false],
];

const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        valid: { type: 'boolean' },
        reason: { type: 'string', maxLength: 60 },
    },
    required: ['valid', 'reason'],
    additionalProperties: false,
};

const TWO_STEP_SCHEMA = {
    type: 'object',
    properties: {
        // 판정보다 먼저 쓰게 한다. 스키마의 속성 순서가 생성 순서다.
        what: { type: 'string', maxLength: 60, description: '이 낱말이 무엇인지. 모르면 "모름"' },
        known: { type: 'boolean', description: '무엇인지 확실히 아는가' },
        valid: { type: 'boolean' },
        reason: { type: 'string', maxLength: 60 },
    },
    required: ['what', 'known', 'valid', 'reason'],
    additionalProperties: false,
};

async function oneStep(topic, word) {
    return judge(topic, word);
}

async function twoStep(topic, word) {
    return askJson({
        role: 'judge',
        maxTokens: 500,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 심판이다.

판정하기 전에 그 낱말이 **무엇인지** 먼저 밝힌다. 순서를 지켜라.
  what  : 그 낱말이 무엇인지 한 마디로. 확실히 모르면 "모름" 이라고 쓴다.
  known : 확실히 아는가
  valid : 주제에 맞는가
  reason: 왜 그렇게 판정했는가

[판정 기준]
1. what 에 적은 것을 근거로 판정한다. 적어 놓고 다른 이유를 대지 않는다.
2. 주제 안에 있는 것, 주제에서 쓰는 것, 거기서 파는 것 — 통과다.
   반갑지 않은 것이라도(잡초, 곰팡이, 소음) 그 자리에 있으면 통과다.
3. known 이 false 면 통과시킬 근거가 없다. valid 도 false 다.
   모르는 낱말을 "관련 있어 보인다" 며 통과시키지 않는다.
4. 알고 있는데 경계에 걸친 것이라면 통과시킨다.
   억울한 탈락이 느슨한 통과보다 나쁘다.
5. 계절이나 환경이 반대여서 그 자리에 놓이지 않으면 탈락이다.`,
        user: `주제: "${topic}"\n제출된 단어: "${word}"\n\n`
            + `이 낱말이 무엇인지 먼저 밝히고, 그다음 주제에 맞는지 판정해주세요.`,
        schema: TWO_STEP_SCHEMA,
    });
}

async function timed(fn) {
    const t = Date.now();
    try {
        const out = await fn();
        return { ms: Date.now() - t, out };
    } catch (e) {
        return { ms: Date.now() - t, out: null, error: e.message };
    }
}

async function run(name, fn, showWhat = false) {
    clearVerdictCache();
    let hit = 0, elapsed = 0;
    const wrong = [];
    const notes = [];

    for (const [topic, word, want] of CASES) {
        const { ms, out, error } = await timed(() => fn(topic, word));
        elapsed += ms;
        if (error) { wrong.push(`${topic}/${word}(오류)`); continue; }
        if (Boolean(out.valid) === want) hit++;
        else wrong.push(`${topic}/${word}(${out.valid ? '통과' : '탈락'})`);
        if (showWhat) {
            notes.push(`    ${(topic + '/' + word).padEnd(14)} known=${out.known ? 'O' : '✗'}  `
                + `what="${out.what}"`);
        }
    }

    return { name, rate: hit / CASES.length, hit, wrong, perCase: Math.round(elapsed / CASES.length), notes };
}

console.log(`\n  케이스 ${CASES.length}개\n`);
const a = await run('1단계 (지금)', oneStep);
const b = await run('2단계 (무엇인지 먼저)', twoStep, true);

console.log('  ' + '방식'.padEnd(26) + '정확도        건당');
console.log('  ' + '-'.repeat(52));
for (const r of [a, b]) {
    console.log('  ' + r.name.padEnd(24)
        + (String(Math.round(r.rate * 100)) + '%').padStart(5) + ` (${r.hit}/${CASES.length})`
        + (r.perCase + 'ms').padStart(10));
}
console.log('');
for (const r of [a, b]) console.log(`  ${r.name}\n    ✗ ${r.wrong.join(', ') || '없음'}\n`);

console.log('  [2단계] 모델이 각 낱말을 무엇이라고 봤나 — 여기가 틀리면 판정도 틀린다');
for (const line of b.notes) console.log(line);
console.log('');
