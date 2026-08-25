/**
 * 로컬 Ollama 백엔드.
 *
 * Ollama 는 `format` 에 JSON 스키마를 그대로 넘길 수 있어서,
 * Anthropic 쪽의 output_config.format 과 같은 방식으로 응답 형태를 강제할 수 있다.
 *
 * 클라우드와 다른 점 하나 : 여기서는 temperature 를 실제로 쓸 수 있다.
 * 판정은 0 으로 고정해 일관성을 잡고, 단어 생성만 온도를 올려 다양성을 준다.
 */

const HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');

// 모델을 VRAM 에 얼마나 붙잡아 둘지. 매 턴 다시 올리면 몇 초씩 날아가므로 넉넉히 잡는다.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

// Qwen3 같은 하이브리드 추론 모델은 기본적으로 <think> 를 뱉는다.
// 게임에는 방해만 되므로 끄는데, 이 옵션을 모르는 모델도 있어서 한 번 실패하면 영구히 뺀다.
let sendThinkFlag = true;

export async function askJsonOllama({ system, user, schema, maxTokens = 512, model, temperature = 0 }) {
    const body = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        stream: false,
        format: schema,          // JSON 스키마 강제
        keep_alive: KEEP_ALIVE,
        options: {
            temperature,
            num_predict: maxTokens,
            // 작은 모델이 같은 문장을 반복하다 토큰을 다 쓰는 것을 억제한다
            repeat_penalty: 1.2,
        },
    };
    if (sendThinkFlag) body.think = false;

    let data;
    try {
        data = await post(body);
    } catch (err) {
        // think 를 모르는 모델이면 그 옵션만 빼고 한 번 더 시도한다
        if (sendThinkFlag && /think/i.test(err.message)) {
            sendThinkFlag = false;
            console.warn('[ollama] 이 모델은 think 옵션을 지원하지 않습니다 → 빼고 계속합니다.');
            delete body.think;
            data = await post(body);
        } else {
            throw err;
        }
    }

    return parseOrRetry(data, body);
}

/**
 * 응답이 잘리거나 깨졌을 때 한 번만 다시 물어본다.
 * 작은 모델은 답이 길어지다 토큰 한도에 걸려 JSON 이 잘리는 일이 있는데,
 * 온도를 올려 다른 경로로 답하게 하면 대개 한 번에 붙는다.
 */
async function parseOrRetry(data, body, retried = false) {
    const text = String(data?.message?.content ?? '').trim();

    if (text) {
        try {
            return JSON.parse(text);
        } catch (e) {
            // 아래에서 재시도
        }
    }

    if (retried) {
        throw new Error('로컬 모델 응답을 JSON 으로 읽지 못했습니다: ' + text.slice(0, 200));
    }

    console.warn(`[ollama] ${body.model} 응답이 잘렸습니다 → 짧게 답하도록 지시하고 재시도합니다.`);
    const retryBody = {
        ...body,
        messages: [
            ...body.messages,
            { role: 'user', content: '방금 답이 잘렸습니다. 설명을 반복하지 말고, 아주 짧게 다시 답해주세요.' },
        ],
        options: { ...body.options, temperature: 0.3, repeat_penalty: 1.3 },
    };
    return parseOrRetry(await post(retryBody), retryBody, true);
}

async function post(body) {
    let res;
    try {
        res = await fetch(HOST + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        const err = new Error(`Ollama 서버(${HOST})에 연결하지 못했습니다. 실행 중인지 확인해주세요.`);
        err.status = 503;
        throw err;
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (res.status === 404) {
            const err = new Error(`모델 "${body.model}" 이(가) 없습니다. 먼저 \`ollama pull ${body.model}\` 을 실행해주세요.`);
            err.status = 404;
            throw err;
        }
        throw new Error(`Ollama 오류 (${res.status}): ${detail.slice(0, 200)}`);
    }

    return res.json();
}

/** 서버가 살아 있는지, 어떤 모델이 받아져 있는지 확인한다 (시작 화면 안내용) */
export async function ollamaStatus() {
    try {
        const res = await fetch(HOST + '/api/tags', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { up: false, models: [] };
        const data = await res.json();
        return { up: true, models: (data.models || []).map(m => m.name) };
    } catch (e) {
        return { up: false, models: [] };
    }
}

/**
 * 모델을 미리 VRAM 에 올려둔다.
 * 이걸 안 하면 첫 판정에서 모델 적재 시간(수십 초)을 사용자가 그대로 맞는다.
 * 빈 프롬프트로 부르면 Ollama 는 적재만 하고 생성은 하지 않는다.
 */
export async function warmUp(model) {
    const t = Date.now();
    const res = await fetch(HOST + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: KEEP_ALIVE }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    await res.json().catch(() => null);
    return Date.now() - t;
}
