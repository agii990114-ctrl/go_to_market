/**
 * 로컬 모델 비교 스크립트.
 *
 *   node bench/run.js qwen3:4b exaone3.5:7.8b
 *
 * 두 가지를 잰다.
 *
 *   1) 판정 — 통과해야 할 단어를 통과시키는가, 그리고 "탈락시켜야 할 단어를 실제로 탈락시키는가".
 *      두 번째가 핵심이다. 다 통과시키는 모델은 심판 역할을 못 한다.
 *      애매한 케이스는 정답을 정하지 않고 "두 번 물었을 때 같은 답이 나오는가"만 본다.
 *
 *   2) 생성 — 실제 게임처럼 목록을 늘려가며 15번 뽑아, 무엇이 몇 번 어긋나는지 센다.
 */
import 'dotenv/config';
import { judge, generateWords } from '../server/agents.js';
import { cleanWord, isUsableWord, normalize } from '../server/game.js';
import { isRealWord } from '../server/dictionary.js';
import { clearVerdictCache } from '../server/verdict-cache.js';

/* 통과해야 하는 것 */
const SHOULD_PASS = [
    ['시장', '고등어'], ['시장', '흥정'], ['시장', '떡볶이'], ['시장', '뻥튀기'],
    ['동물원', '코끼리'], ['동물원', '사육사'],
    ['냉장고', '김치'], ['냉장고', '계란'],
    ['바다', '파도'], ['병원', '간호사'],
    ['학교', '칠판'], ['여름', '매미'],
    // 실제로 억울하게 탈락했던 것들. 다시는 떨어지면 안 된다.
    ['냉장고', '고기'], ['냉장고', '우유'], ['냉장고', '반찬'], ['냉장고', '얼음'],
    ['시장', '향신료'], ['시장', '상인'], ['시장', '지갑'],
    // "정반대는 탈락" 규칙 때문에 계절 단어가 과하게 걸리지 않는지 지킨다
    ['여름', '빙수'], ['여름', '에어컨'], ['겨울', '장갑'], ['겨울', '눈사람'],
];

/* 탈락해야 하는 것 */
const SHOULD_FAIL = [
    ['시장', '은하수'], ['시장', '미적분'], ['시장', 'asdfgh'],
    ['동물원', '주식배당금'], ['냉장고', '화산폭발'], ['냉장고', 'ㅁㄴㅇㄹ'],
    ['바다', '프린터'], ['병원', '용암'],
    ['학교', '심해어'],
    // 무관이 아니라 정반대라 탈락해야 하는 것들
    ['여름', '눈사람'], ['여름', '털장갑'], ['냉장고', '화로'],
];

/* 정답을 정하지 않고 일관성만 보는 것 */
const AMBIGUOUS = [
    ['시장', '노트북'], ['동물원', '아이스크림'], ['냉장고', '곰팡이'],
    ['바다', '쓰레기'], ['학교', '첫사랑'], ['여름', '이별'],
];

const GEN_TOPIC = '시장';
const GEN_ROUNDS = 15;

async function benchJudge(model) {
    process.env.MODEL_JUDGE = model;
    const times = [];
    const wrong = { pass: [], fail: [] };
    const errors = [];

    let passHit = 0;
    for (const [topic, word] of SHOULD_PASS) {
        const { ms, out, error } = await timed(() => judge(topic, word));
        times.push(ms);
        if (error) errors.push(`${topic}/${word}: ${error.slice(0, 50)}`);
        else if (out.valid) passHit++;
        else wrong.pass.push(`${topic}/${word}`);
    }

    let failHit = 0;
    for (const [topic, word] of SHOULD_FAIL) {
        const { ms, out, error } = await timed(() => judge(topic, word));
        times.push(ms);
        if (error) errors.push(`${topic}/${word}: ${error.slice(0, 50)}`);
        else if (!out.valid) failHit++;
        else wrong.fail.push(`${topic}/${word}`);
    }

    // 판정 캐시가 켜져 있으면 두 번째 질문은 무조건 같은 답이라 일관성이 100% 로 나온다.
    // 그건 캐시를 재는 것이지 모델을 재는 게 아니다. 사이사이 캐시를 비운다.
    let consistent = 0;
    for (const [topic, word] of AMBIGUOUS) {
        clearVerdictCache();
        const a = await timed(() => judge(topic, word));
        clearVerdictCache();
        const b = await timed(() => judge(topic, word));
        times.push(a.ms, b.ms);
        if (a.error || b.error) errors.push(`${topic}/${word}: ${(a.error || b.error).slice(0, 50)}`);
        else if (a.out.valid === b.out.valid) consistent++;
    }

    return {
        passRate: passHit / SHOULD_PASS.length,
        failRate: failHit / SHOULD_FAIL.length,
        consistency: consistent / AMBIGUOUS.length,
        avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        maxMs: Math.max(...times),
        wrong,
        errors,
    };
}

async function benchGenerate(model) {
    process.env.MODEL_GENERATE = model;
    const kept = [];
    const problems = { topicEcho: 0, duplicate: 0, notAWord: 0, notInDict: 0, failed: 0 };

    // 게임과 같은 방식으로 한 번에 여러 개를 받아 코드로 거른다
    const { ms, out, error } = await timed(() => generateWords(GEN_TOPIC, [], GEN_ROUNDS));
    if (error) {
        problems.failed++;
        return { kept, unique: 0, problems, ms, asked: GEN_ROUNDS, got: 0 };
    }

    const raw = out?.words || [];
    for (const item of raw) {
        const word = cleanWord(item);
        if (!isUsableWord(word) || !/^[가-힣]{2,8}$/.test(word)) { problems.notAWord++; continue; }
        if (normalize(word) === normalize(GEN_TOPIC)) { problems.topicEcho++; continue; }
        if (kept.some(w => normalize(w) === normalize(word))) { problems.duplicate++; continue; }
        if (!isRealWord(word)) { problems.notInDict++; continue; }
        kept.push(word);
    }

    return { kept, unique: kept.length, problems, ms, asked: GEN_ROUNDS, got: raw.length };
}

/**
 * 한 케이스가 터져도 벤치 전체가 죽지 않게 한다.
 * 오류 자체도 그 모델의 성적이므로 세어서 보고한다.
 */
async function timed(fn) {
    // 객체 리터럴은 속성을 순서대로 평가한다. await 을 먼저 끝내고 나서 시간을 재야 한다.
    const t = Date.now();
    try {
        const out = await fn();
        return { ms: Date.now() - t, out };
    } catch (e) {
        return { ms: Date.now() - t, out: null, error: e.message };
    }
}

const pct = n => (n * 100).toFixed(0).padStart(3) + '%';

const models = process.argv.slice(2);
if (!models.length) {
    console.error('사용법: node bench/run.js <모델> [모델 ...]');
    process.exit(1);
}

process.env.LLM_PROVIDER = 'ollama';

for (const model of models) {
    console.log(`\n${'='.repeat(58)}\n  ${model}\n${'='.repeat(58)}`);

    // 첫 호출은 모델을 VRAM 에 올리는 시간이 섞이므로 측정에서 제외한다
    process.env.MODEL_JUDGE = model;
    process.stdout.write('  (모델 적재 중…) ');
    const warm = await timed(() => judge('시장', '사과'));
    console.log(`${warm.ms}ms\n`);

    const j = await benchJudge(model);
    console.log('  [판정]');
    console.log(`    통과해야 할 것을 통과 : ${pct(j.passRate)}  (${SHOULD_PASS.length}개 중)`);
    console.log(`    탈락시켜야 할 것을 탈락 : ${pct(j.failRate)}  (${SHOULD_FAIL.length}개 중)   ← 변별력`);
    console.log(`    애매한 것 재질문 일관성 : ${pct(j.consistency)}  (${AMBIGUOUS.length}개 중)`);
    console.log(`    응답 : 평균 ${j.avgMs}ms / 최대 ${j.maxMs}ms`);
    if (j.wrong.pass.length) console.log(`    ✗ 통과했어야 하는데 탈락 : ${j.wrong.pass.join(', ')}`);
    if (j.wrong.fail.length) console.log(`    ✗ 탈락했어야 하는데 통과 : ${j.wrong.fail.join(', ')}`);
    if (j.errors.length) {
        console.log(`    ⚠️  응답 실패 ${j.errors.length}건`);
        for (const e of j.errors.slice(0, 3)) console.log(`         ${e}`);
    }

    const g = await benchGenerate(model);
    console.log(`
  [생성]  주제 "${GEN_TOPIC}" 으로 ${g.asked}개를 한 번에 요청`);
    console.log(`    돌려받은 개수 : ${g.got}`);
    console.log(`    쓸 만한 단어 : ${g.unique}개  (한 개당 ${g.unique ? (g.ms / g.unique).toFixed(0) : '—'}ms)`);
    console.log(`    걸러진 것 — 사전에 없음 ${g.problems.notInDict} · 낱말이 아님 ${g.problems.notAWord}`
        + ` · 주제 그대로 ${g.problems.topicEcho} · 중복 ${g.problems.duplicate} · 실패 ${g.problems.failed}`);
    console.log(`    응답 : ${(g.ms / 1000).toFixed(1)}초`);
    console.log(`    남은 단어 : ${g.kept.join(', ') || '(없음)'}`);
}
console.log('');
