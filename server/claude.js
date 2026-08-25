/**
 * Anthropic API 백엔드.
 * - JSON 스키마로 응답 형태를 강제한다 (output_config.format).
 * - Claude Opus 5 부터는 temperature 를 받지 않는다(400). 판정의 일관성은
 *   "온도 0" 이 아니라 구조화 출력 + 고정된 판정 기준 문장으로 확보한다.
 *   (로컬 모델은 온도를 쓸 수 있다 — ollama.js 참고)
 *
 * 라우팅은 llm.js 가 한다. 이 파일은 Anthropic 호출만 담당한다.
 */
import Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'low';   // 단순한 판정이라 low 로 충분하다

// 클라이언트는 처음 쓸 때 만든다. 키가 없어도 서버 자체는 떠야
// 시작 화면에서 "키가 없습니다" 안내를 보여줄 수 있다.
let client = null;
function getClient() {
    if (!client) client = new Anthropic();   // ANTHROPIC_API_KEY 를 환경변수에서 읽는다
    return client;
}

// 안전 분류기에 걸렸을 때 자동으로 다른 모델로 넘겨주는 옵션.
// 설치된 SDK 나 계정이 이 베타를 모르면 한 번 실패한 뒤 영구히 끄고 계속 진행한다.
let useFallbacks = true;

export async function askJsonAnthropic({ system, user, schema, maxTokens = 2048, model = ANTHROPIC_MODEL }) {
    const body = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
            effort: EFFORT,
            format: { type: 'json_schema', schema },
        },
    };

    let response;
    if (useFallbacks) {
        try {
            response = await getClient().beta.messages.create({
                ...body,
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
            });
        } catch (err) {
            if (isUnsupportedParamError(err)) {
                useFallbacks = false;
                console.warn('[claude] server-side fallback 미지원 → 비활성화하고 계속합니다.');
                response = await getClient().messages.create(body);
            } else {
                throw err;
            }
        }
    } else {
        response = await getClient().messages.create(body);
    }

    if (response.stop_reason === 'refusal') {
        const err = new Error('모델이 응답을 거부했습니다. 다른 주제로 시도해주세요.');
        err.code = 'REFUSAL';
        throw err;
    }

    const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();

    if (!text) throw new Error('모델이 빈 응답을 돌려주었습니다.');

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('모델 응답을 JSON 으로 읽지 못했습니다: ' + text.slice(0, 200));
    }
}

// 400 계열 중 "이 파라미터/베타를 모른다" 류인지 대충 가려낸다
function isUnsupportedParamError(err) {
    if (err?.status !== 400 && err?.status !== 404) return false;
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('fallback') || msg.includes('beta') || msg.includes('unexpected');
}
