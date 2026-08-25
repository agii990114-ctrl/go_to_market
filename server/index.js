/**
 * 시장에 가면 - AI 대결 버전 : 프록시 서버
 *
 * API 키는 이 서버에만 있고 브라우저로는 절대 나가지 않는다.
 * 프런트는 /api/* 만 호출한다.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOCK, llmStatus, modelFor, providerFor, warmUpLocalModels } from './llm.js';
import { judge, suggestTopics } from './agents.js';
import { isDuplicate, playAiTurn } from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const REFEREE_ON_AI = process.env.REFEREE_ON_AI !== 'false';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(here, '..', 'public')));

/* 요청 본문 검증 : 주제와 단어 길이를 서버에서도 한 번 더 막는다 */
function readTopic(body) {
    const topic = String(body?.topic ?? '').trim();
    if (!topic || topic.length > 20) throw badRequest('주제는 1~20자로 보내주세요.');
    return topic;
}

function readWords(body) {
    const words = Array.isArray(body?.usedWords) ? body.usedWords : [];
    if (words.length > 300) throw badRequest('단어 목록이 너무 깁니다.');
    return words.map(w => String(w).trim()).filter(Boolean);
}

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

/* -----------------------------------------------------------
   상태 확인 : 키가 꽂혀 있는지 프런트가 시작 화면에서 확인한다
----------------------------------------------------------- */
app.get('/api/health', async (req, res, next) => {
    try {
        const status = await llmStatus();
        res.json({ ok: true, refereeOnAi: REFEREE_ON_AI, ...status });
    } catch (err) {
        next(err);
    }
});

/* -----------------------------------------------------------
   주제 추천
----------------------------------------------------------- */
app.post('/api/topics', async (req, res, next) => {
    try {
        // 작은 모델은 가끔 빈 배열이나 영어·기호가 섞인 것을 돌려준다.
        // 걸러 낸 뒤 너무 적으면 한 번만 더 물어본다.
        let topics = cleanTopics(await suggestTopics());
        if (topics.length < 3) {
            topics = [...new Set([...topics, ...cleanTopics(await suggestTopics())])];
        }
        res.json({ topics: topics.slice(0, 5) });
    } catch (err) {
        next(err);
    }
});

function cleanTopics(result) {
    return (result?.topics || [])
        .map(t => String(typeof t === 'string' ? t : t?.topic ?? '').trim())
        .filter(t => /^[가-힣 ]{2,12}$/.test(t));
}

/* -----------------------------------------------------------
   내가 낸 단어 심판
----------------------------------------------------------- */
app.post('/api/judge', async (req, res, next) => {
    try {
        const topic = readTopic(req.body);
        const word = String(req.body?.word ?? '').trim();
        if (!word || word.length > 30) throw badRequest('단어는 1~30자로 보내주세요.');

        // 중복은 AI 에 묻지 않는다
        const usedWords = readWords(req.body);
        if (isDuplicate(word, usedWords)) {
            return res.json({ valid: false, duplicate: true, reason: '이미 나온 단어예요.' });
        }

        const verdict = await judge(topic, word);
        res.json({ valid: Boolean(verdict.valid), duplicate: false, reason: verdict.reason || '' });
    } catch (err) {
        next(err);
    }
});

/* -----------------------------------------------------------
   AI 차례 : 생성 → 검수 → 심판 루프를 서버 안에서 다 돌린다
   (퇴짜맞은 후보는 프런트로 나가지 않으므로 정보가 새지 않는다)
----------------------------------------------------------- */
app.post('/api/ai-turn', async (req, res, next) => {
    try {
        const topic = readTopic(req.body);
        const usedWords = readWords(req.body);
        const result = await playAiTurn(topic, usedWords, REFEREE_ON_AI);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

/* -----------------------------------------------------------
   에러 처리 : 게임을 끝내지 말고 프런트가 재시도할 수 있게 한다
----------------------------------------------------------- */
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[api]', err);

    let message = err.message || '알 수 없는 오류가 발생했습니다.';
    if (status === 401) message = 'API 키가 올바르지 않습니다. .env 파일을 확인해주세요.';
    if (status === 429) message = '요청이 너무 잦습니다. 잠시 뒤 다시 시도해주세요.';

    res.status(status).json({ error: message });
});

app.listen(PORT, () => {
    console.log(`\n  🛒 시장에 가면 (AI 대결)  →  http://localhost:${PORT}`);
    for (const role of ['judge', 'inspect', 'generate', 'topics']) {
        console.log(`    ${role.padEnd(9)} ${providerFor(role)} / ${modelFor(role)}`);
    }
    console.log(`  AI 단어 심판 재확인: ${REFEREE_ON_AI ? '켜짐' : '꺼짐'}`);

    if (MOCK) {
        console.log('\n  🧪 목업 모드입니다. 실제 모델을 부르지 않고 정해진 단어로만 돕니다.\n');
        return;
    }
    llmStatus().then(status => {
        if (status.problems.length) {
            console.log('');
            for (const p of status.problems) console.log('  ⚠️  ' + p);
            console.log('');
            return;
        }
        console.log('  ⏳ 로컬 모델을 미리 올리는 중… (첫 턴이 느려지지 않게)');
        warmUpLocalModels().then(results => {
            for (const r of results) {
                console.log(r.error ? `  ⚠️  ${r.model} 적재 실패: ${r.error}`
                                    : `  ✅ ${r.model} 적재 완료 (${(r.ms / 1000).toFixed(1)}초)`);
            }
            console.log('  ✅ 준비 완료\n');
        });
    });
});
