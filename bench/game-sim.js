/**
 * 실제 게임 루프를 그대로 돌려 본다.
 *
 *   node bench/game-sim.js 시장 8
 *
 * bench/run.js 는 생성만 따로 재기 때문에, 지어낸 말이 검수·심판에 걸리는지까지는
 * 보지 못한다. 이 스크립트는 playAiTurn() 을 그대로 불러서
 * "정말로 채택되는 단어" 와 "턴당 실제 대기 시간" 을 잰다.
 */
import 'dotenv/config';
import { playAiTurn } from '../server/game.js';
import { modelFor, providerFor } from '../server/llm.js';

const topic = process.argv[2] || '시장';
const turns = parseInt(process.argv[3], 10) || 8;
const refereeOnAi = process.env.REFEREE_ON_AI !== 'false';

console.log(`\n  주제 "${topic}" 으로 AI 차례 ${turns}번`);
for (const role of ['generate', 'inspect', 'judge']) {
    console.log(`    ${role.padEnd(9)} ${providerFor(role)} / ${modelFor(role)}`);
}
console.log(`    심판 재확인 : ${refereeOnAi ? '켜짐' : '꺼짐'}\n`);

const used = [];
const times = [];
let exhaustedAt = null;

for (let turn = 1; turn <= turns; turn++) {
    const t = Date.now();
    const result = await playAiTurn(topic, used, refereeOnAi);
    const ms = Date.now() - t;
    times.push(ms);

    // 채택되기까지 몇 번 퇴짜맞았는지, 무엇에 걸렸는지
    const rejects = result.log.filter(l => !l.passed);
    const trail = rejects.length
        ? '  ← ' + rejects.map(l => `${l.word || '?'}(${l.stage})`).join(' ')
        : '';

    if (result.outcome === 'exhausted') {
        console.log(`  ${String(turn).padStart(2)}. ✖ 더 낼 단어 없음 (${(ms / 1000).toFixed(1)}초)${trail}`);
        exhaustedAt = turn;
        break;
    }

    used.push(result.word);
    console.log(`  ${String(turn).padStart(2)}. ${result.word.padEnd(10)} `
        + `${(ms / 1000).toFixed(1)}초 · 시도 ${result.attempts}회${trail}`);
}

const avg = times.reduce((a, b) => a + b, 0) / times.length / 1000;
console.log(`\n  채택된 단어 : ${used.join(', ') || '(없음)'}`);
console.log(`  AI 차례 평균 : ${avg.toFixed(1)}초 / 최대 ${(Math.max(...times) / 1000).toFixed(1)}초`);
if (exhaustedAt) console.log(`  ${exhaustedAt}번째 차례에서 주제가 바닥났습니다 (= 사람 승리)`);
console.log('');
