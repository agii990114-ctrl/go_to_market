/**
 * 고유명사 판정 : 세 방식 비교.
 *
 *   node bench/rag-vs-lookup.js
 *
 * "게임" 처럼 고유명사가 쏟아지는 주제에서 심판이 무너진다.
 * 모델은 원신이 게임인 걸 직접 물으면 알지만, 판정할 때는 그 지식을 안 쓴다.
 * 지어낸 이름(카르네시아)도 그럴듯한 이유를 붙여 통과시킨다.
 *
 * 고치는 방법 세 가지를 같은 케이스로 잰다.
 *
 *   BASE   지금 그대로. 프롬프트만.
 *   LOOKUP 위키백과 제목에 없으면 즉시 탈락(0ms). 있으면 평소대로 판정.
 *   RAG    위키백과 요약문을 가져와 프롬프트에 넣고 판정. 문서가 없으면 탈락.
 *
 * 재는 것은 정확도와 한 건당 걸린 시간.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from '../server/agents.js';
import { askJson } from '../server/llm.js';
import { clearVerdictCache } from '../server/verdict-cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TITLE_FILE = path.join(here, '..', 'data', 'wiki-titles.txt');

const TOPIC = '게임';

/* 정답이 분명한 케이스 — 여기서 나온 숫자가 진짜 성적이다 */
const CLEAR = [
    // 진짜 게임 — 통과해야 한다
    ['원신', true], ['테트리스', true], ['마인크래프트', true],
    ['스타크래프트', true], ['배틀그라운드', true],
    // 지어낸 이름 — 탈락해야 한다
    ['카르네시아', false], ['아르카티스', false], ['젤리트론', false],
    ['블루펜타', false], ['뮤렌시아', false],
    // 게임에서 쓰는 일반명사 — 통과해야 한다
    ['조이스틱', true], ['아이템', true], ['레벨', true], ['승리', true],
];

/*
 * 정답을 못 박기 어려운 케이스.
 * 실재하는 고유명사이지만 게임은 아니다. 다만 우리 판정 기준은 관대해서
 * ("이어지는 지점이 있으면 통과") 통과시켜도 규칙 위반은 아니다.
 * 성적에 넣지 않고, 세 방식이 각각 어떻게 판단하는지만 따로 본다.
 */
const DEBATABLE = ['넷플릭스', '스타벅스', '샤넬', '인스타그램', '카카오톡'];

const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        valid: { type: 'boolean' },
        reason: { type: 'string', maxLength: 60 },
    },
    required: ['valid', 'reason'],
    additionalProperties: false,
};

/* ---------- 준비 ---------- */

let titles = null;
function loadTitles() {
    if (titles) return titles;
    if (!fs.existsSync(TITLE_FILE)) {
        console.error('\n  위키 제목 목록이 없습니다. 먼저 아래를 실행해주세요.\n');
        console.error('    node scripts/fetch-wiki-titles.js\n');
        process.exit(1);
    }
    const text = fs.readFileSync(TITLE_FILE, 'utf8');
    // 파일이 CRLF 로 저장돼 있을 수 있다. \r 을 떼지 않으면 조회가 전부 빗나간다.
    titles = new Set(text.split(/\r?\n/).map(t => t.trim()).filter(Boolean));
    return titles;
}

const summaryCache = new Map();
async function wikiSummary(word) {
    if (summaryCache.has(word)) return summaryCache.get(word);
    let result = null;
    try {
        const res = await fetch(
            'https://ko.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(word),
            { headers: { 'User-Agent': 'go_to_market-bench/1.0' }, signal: AbortSignal.timeout(8000) },
        );
        if (res.ok) {
            const data = await res.json();
            if (data.type !== 'disambiguation' && data.extract) {
                result = String(data.extract).slice(0, 300);
            }
        }
    } catch (e) {
        result = null;
    }
    summaryCache.set(word, result);
    return result;
}

/* ---------- 세 방식 ---------- */

async function base(word) {
    return judge(TOPIC, word);
}

async function lookup(word) {
    // 고유명사로 보이는데 위키에 문서가 없으면 지어낸 말로 본다.
    // 일반명사는 국어사전 쪽에서 이미 걸러지므로 여기서는 위키만 본다.
    if (!loadTitles().has(word)) {
        const { isRealWord } = await import('../server/dictionary.js');
        if (!isRealWord(word)) {
            return { valid: false, reason: '실재하지 않는 말입니다.', shortCircuit: true };
        }
    }
    return judge(TOPIC, word);
}

async function rag(word) {
    const extract = await wikiSummary(word);
    if (!extract) {
        return { valid: false, reason: '무엇인지 확인할 수 없습니다.', shortCircuit: true };
    }
    return askJson({
        role: 'judge',
        maxTokens: 400,
        // 평소 판정과 기준을 같게 두고 [자료] 만 더한다.
        // 기준까지 바꾸면 "근거를 주면 나아지는가" 가 아니라 다른 걸 재게 된다.
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 심판이다.
플레이어가 낸 단어가 주제에 맞는지만 판정한다.
[자료] 가 주어지면 그 단어가 무엇인지 그 자료로 확인한 뒤 판정한다.
자료에 없는 내용을 지어내지 않는다.

1. 기본은 통과다. 이어지는 지점이 아예 없을 때만 탈락시킨다.
2. 주제 안에 있는 것, 주제에서 쓰는 것, 주제에 속하는 것 — 전부 통과다.
3. 애매하면 통과시킨다. 억울한 탈락이 느슨한 통과보다 나쁘다.
4. 자료를 보니 주제와 아예 다른 종류의 것이면 탈락이다.

[출력 규칙] reason 은 40자 이내 한 문장.`,
        user: `주제: "${TOPIC}"\n제출된 단어: "${word}"\n\n[자료]\n${extract}\n\n이 단어는 주제에 맞습니까?`,
        schema: VERDICT_SCHEMA,
    });
}

/* ---------- 실행 ---------- */

async function run(name, fn) {
    clearVerdictCache();
    let hit = 0, shortCircuits = 0, elapsed = 0;
    const wrong = [];

    for (const [word, want] of CLEAR) {
        const t = Date.now();
        let out;
        try {
            out = await fn(word);
        } catch (e) {
            out = { valid: true, reason: 'ERROR: ' + e.message };
        }
        elapsed += Date.now() - t;
        if (out.shortCircuit) shortCircuits++;
        if (Boolean(out.valid) === want) hit++;
        else wrong.push(`${word}(${out.valid ? '통과' : '탈락'})`);
    }

    return {
        name,
        rate: hit / CLEAR.length,
        hit,
        wrong,
        perCase: Math.round(elapsed / CLEAR.length),
        shortCircuits,
    };
}

console.log(`\n  주제 "${TOPIC}" · 확실한 케이스 ${CLEAR.length}개 + 애매한 케이스 ${DEBATABLE.length}개\n`);
console.log('  위키 제목 적재 중…');
const t0 = Date.now();
const n = loadTitles().size;
console.log(`  ${n.toLocaleString()}개 (${Date.now() - t0}ms)\n`);

const results = [];
results.push(await run('BASE   프롬프트만', base));
results.push(await run('LOOKUP 위키 제목 조회', lookup));
results.push(await run('RAG    위키 요약 주입', rag));

console.log('  ' + '방식'.padEnd(24) + '정확도      건당      코드가 즉결한 수');
console.log('  ' + '-'.repeat(66));
for (const r of results) {
    console.log('  ' + r.name.padEnd(22)
        + (String(Math.round(r.rate * 100)) + '%').padStart(5)
        + ` (${r.hit}/${CLEAR.length})`
        + (r.perCase + 'ms').padStart(10)
        + String(r.shortCircuits).padStart(12));
}
console.log('');
for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    ✗ ${r.wrong.join(', ') || '없음'}\n`);
}

console.log('  [애매한 케이스] 실재하지만 게임은 아닌 것 — 성적에 넣지 않는다');
for (const [name, fn] of [['BASE', base], ['LOOKUP', lookup], ['RAG', rag]]) {
    clearVerdictCache();
    const marks = [];
    for (const word of DEBATABLE) {
        let out;
        try { out = await fn(word); } catch (e) { out = { valid: true }; }
        marks.push(word + (out.valid ? '(통과)' : '(탈락)'));
    }
    console.log('    ' + name.padEnd(8) + marks.join(' '));
}
console.log('');
