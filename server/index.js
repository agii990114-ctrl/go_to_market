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
import { cacheStats } from './verdict-cache.js';
import { judge, suggestTopics, validateTopic, generateWords } from './agents.js';
import { checkTopicShape } from './topic.js';
import { isRealWord } from './dictionary.js';
import { isDuplicate, playAiTurn } from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const REFEREE_ON_AI = process.env.REFEREE_ON_AI !== 'false';

app.use(express.json({ limit: '64kb' }));
// 프런트 파일은 캐시하지 않는다.
// 고친 뒤 새로고침해도 브라우저가 옛 game.js 를 들고 있어 "함수가 없다" 는
// 엉뚱한 오류로 시간을 버린 적이 있다. 로컬 전용 서버라 캐시로 얻을 것도 없다.
app.use(express.static(path.join(here, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

/* 요청 본문 검증 : 주제와 단어 길이를 서버에서도 한 번 더 막는다 */
function readTopic(body) {
    const topic = String(body?.topic ?? '').trim();
    if (!topic || topic.length > 24) throw badRequest('주제는 1~24자로 보내주세요.');
    return topic;
}

function readWords(body) {
    const words = Array.isArray(body?.usedWords) ? body.usedWords : [];
    if (words.length > 300) throw badRequest('단어 목록이 너무 깁니다.');
    return words.map(w => String(w).trim()).filter(Boolean);
}

/** 언어는 'ko' 아니면 'en' 둘뿐이다 */
function readLang(body) {
    return body?.lang === 'en' ? 'en' : 'ko';
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
        res.json({ ok: true, refereeOnAi: REFEREE_ON_AI, verdictCache: cacheStats(), ...status });
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
        const lang = readLang(req.body);
        let topics = cleanTopics(await suggestTopics(lang), lang);
        if (topics.length < 3) {
            topics = [...new Set([...topics, ...cleanTopics(await suggestTopics(lang), lang)])];
        }
        res.json({ topics: topics.slice(0, 5) });
    } catch (err) {
        next(err);
    }
});

// 추천도 사람 입력과 같은 관문을 통과해야 한다.
// 모델이 "시장과일" 같은 조어를 계속 만들어 내는데, 검증에서 되돌려 보낼
// 주제를 추천 목록에 올리면 앞뒤가 안 맞는다.
function cleanTopics(result, lang = 'ko') {
    const shape = lang === 'en' ? /^[a-zA-Z ]{2,16}$/ : /^[가-힣 ]{2,12}$/;
    return (result?.topics || [])
        .map(t => String(typeof t === 'string' ? t : t?.topic ?? '').trim())
        .map(t => (lang === 'en' ? t.toLowerCase() : t))
        .filter(t => shape.test(t))
        .filter(t => checkTopicShape(t, lang).ok);
}

/* -----------------------------------------------------------
   주제 검증 : 조어는 코드가, 장소인지는 모델이 본다
----------------------------------------------------------- */
app.post('/api/topic-check', async (req, res, next) => {
    try {
        const topic = String(req.body?.topic ?? '').trim();
        const lang = readLang(req.body);

        const shape = checkTopicShape(topic, lang);
        if (!shape.ok) {
            return res.json({ ok: false, reason: shape.reason, byCode: true });
        }

        const verdict = await validateTopic(topic, lang);
        res.json({
            ok: verdict.isPlace,
            reason: verdict.reason,
            byCode: false,
        });
    } catch (err) {
        next(err);
    }
});

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

        const lang = readLang(req.body);

        // 영어 모드에서만 철자를 본다.
        //
        // 모델은 오타를 알아서 고쳐 읽고 통과시킨다 — "towl" 에 대해
        // "You would use a towel at a bathhouse" 라고 답한다. 기억력만 보면 큰 탈이
        // 없지만, 단어장에 towl 이 실리면 잘못된 철자를 가르치는 셈이 된다.
        //
        // 한국어에는 걸지 않는다. 표제어 목록에 "방울토마토" 같은 일상어가 빠져 있어
        // 멀쩡한 단어로 억울하게 지는 일이 생긴다.
        //
        // 그리고 탈락이 아니라 경고다. 중복과 같은 취급이라 다시 입력하면 된다.
        if (lang === 'en') {
            const bad = word.split(/\s+/).filter(w => w && !isRealWord(w, 'en'));
            if (bad.length) {
                return res.json({
                    valid: false,
                    duplicate: false,
                    spelling: true,
                    reason: `"${bad.join(', ')}" 은(는) 영어 사전에 없어요. 철자를 확인해 주세요.`,
                });
            }
        }

        const verdict = await judge(topic, word, lang);
        res.json({ valid: Boolean(verdict.valid), duplicate: false, spelling: false, reason: verdict.reason || '' });
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
        const result = await playAiTurn(topic, usedWords, REFEREE_ON_AI, readLang(req.body));
        res.json(result);
    } catch (err) {
        next(err);
    }
});

/* -----------------------------------------------------------
   에러 처리 : 게임을 끝내지 말고 프런트가 재시도할 수 있게 한다
----------------------------------------------------------- */
/* -----------------------------------------
   단어장 : 한 판이 끝나면 그 주제의 단어를 모아 준다.
   게임에서 쌓은 단어가 목표에 못 미치면 같은 주제의 단어로 채워 준다.
----------------------------------------- */
app.post('/api/wordbook', async (req, res, next) => {
    try {
        const topic = readTopic(req.body);
        const lang = readLang(req.body);
        const target = Math.min(30, Math.max(1, parseInt(req.body?.target, 10) || 10));

        // 게임에서 나온 것들이 먼저다. 방금 외운 것이라 복습 가치가 가장 높다.
        const played = (Array.isArray(req.body?.words) ? req.body.words : [])
            .map(w => ({
                word: String(w?.word ?? '').trim(),
                gloss: String(w?.gloss ?? '').trim(),
                fromGame: true,
            }))
            .filter(w => w.word);

        const seen = new Set(played.map(w => w.word.toLowerCase()));
        const out = [...played];

        // 모자란 만큼만 새로 받는다. 두 번 채워도 안 차면 있는 만큼만 준다.
        for (let round = 0; out.length < target && round < 2; round++) {
            const need = target - out.length;
            const result = await generateWords(topic, [...seen], Math.max(need + 5, 10), lang);

            for (const raw of result?.words || []) {
                if (out.length >= target) break;
                const word = String(typeof raw === 'string' ? raw : raw?.word ?? '').trim();
                const gloss = String(typeof raw === 'string' ? '' : raw?.gloss ?? '').trim();
                if (!word || seen.has(word.toLowerCase())) continue;
                if (!isRealWord(word, lang)) continue;
                seen.add(word.toLowerCase());
                out.push({ word: lang === 'en' ? word.toLowerCase() : word, gloss, fromGame: false });
            }
        }

        res.json({ topic, lang, words: out, target });
    } catch (err) {
        next(err);
    }
});

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
