/**
 * 역할 → 프로바이더 → 모델 라우팅.
 *
 * 게임 코드(agents.js)는 이 파일의 askJson() 만 부른다.
 * 어느 모델이 실제로 답하는지는 전부 .env 로 정해지고, 게임 로직은 몰라도 된다.
 *
 *   LLM_PROVIDER=ollama            기본 프로바이더 (ollama | anthropic)
 *   LLM_PROVIDER_JUDGE=anthropic   역할별로 덮어쓰기 (JUDGE / INSPECT / GENERATE / TOPICS)
 *   OLLAMA_MODEL=exaone3.5:7.8b    로컬 기본 모델
 *   MODEL_GENERATE=qwen3:8b        역할별 모델 덮어쓰기
 */
import { askJsonAnthropic, ANTHROPIC_MODEL } from './claude.js';
import { askJsonOllama, ollamaStatus, warmUp } from './ollama.js';
import { mockAnswer } from './mock.js';

export const MOCK = process.env.MOCK === 'true';
export const ROLES = ['judge', 'inspect', 'generate', 'topics'];

// env 는 호출할 때마다 읽는다. 벤치마크가 실행 중에 모델을 바꿔 끼울 수 있어야 하기 때문.
const defaultProvider = () => (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const defaultOllamaModel = () => process.env.OLLAMA_MODEL || 'exaone3.5:7.8b';

/**
 * 역할별 기본 온도.
 * 판정은 흔들리면 안 되니 0, 단어 생성은 매번 달라야 하니 높게 잡는다.
 * (Anthropic 쪽은 이 값을 쓰지 않는다 — Opus 5 부터 temperature 를 받지 않는다.)
 */
const TEMPERATURE = { judge: 0, inspect: 0, generate: 0.9, topics: 0.7 };

export function providerFor(role) {
    const override = process.env['LLM_PROVIDER_' + role.toUpperCase()];
    return (override || defaultProvider()).toLowerCase();
}

export function modelFor(role, provider = providerFor(role)) {
    const override = process.env['MODEL_' + role.toUpperCase()];
    if (override) return override;
    return provider === 'anthropic' ? ANTHROPIC_MODEL : defaultOllamaModel();
}

/**
 * @param {{role: string, system: string, user: string, schema: object, maxTokens?: number}} params
 */
export async function askJson({ role, system, user, schema, maxTokens }) {
    if (MOCK) return mockAnswer(schema);

    const provider = providerFor(role);
    const model = modelFor(role, provider);

    if (provider === 'anthropic') {
        return askJsonAnthropic({ system, user, schema, maxTokens: maxTokens ?? 2048, model });
    }
    if (provider === 'ollama') {
        return askJsonOllama({
            system, user, schema,
            maxTokens: maxTokens ?? 512,
            model,
            temperature: TEMPERATURE[role] ?? 0,
        });
    }
    throw new Error(`알 수 없는 LLM_PROVIDER: "${provider}" (ollama 또는 anthropic)`);
}

/** 시작 화면에서 "지금 무엇이 준비돼 있는지" 알려주기 위한 상태 확인 */
export async function llmStatus() {
    const roles = Object.fromEntries(
        ROLES.map(role => {
            const provider = providerFor(role);
            return [role, { provider, model: modelFor(role, provider) }];
        })
    );

    if (MOCK) return { ready: true, mock: true, roles, problems: [] };

    const problems = [];
    const usedProviders = new Set(Object.values(roles).map(r => r.provider));

    if (usedProviders.has('anthropic') && !process.env.ANTHROPIC_API_KEY) {
        problems.push('ANTHROPIC_API_KEY 가 없습니다. .env 를 확인해주세요.');
    }

    let ollama = null;
    if (usedProviders.has('ollama')) {
        ollama = await ollamaStatus();
        if (!ollama.up) {
            problems.push('Ollama 서버에 연결하지 못했습니다. `ollama serve` 로 켜주세요.');
        } else {
            // 태그를 생략하고 부른 모델은 :latest 로 등록되므로 그것까지 감안해 찾는다
            const missing = [...new Set(
                Object.values(roles).filter(r => r.provider === 'ollama').map(r => r.model)
            )].filter(m => !ollama.models.some(have => have === m || have === m + ':latest'));

            for (const m of missing) {
                problems.push(`모델 "${m}" 이(가) 없습니다. \`ollama pull ${m}\` 을 실행해주세요.`);
            }
        }
    }

    return { ready: problems.length === 0, mock: false, roles, ollama, problems };
}

/** 로컬 모델을 미리 적재해 첫 턴이 느려지지 않게 한다 */
export async function warmUpLocalModels() {
    if (MOCK) return [];
    const models = [...new Set(
        ROLES.filter(r => providerFor(r) === 'ollama').map(r => modelFor(r))
    )];
    const results = [];
    for (const model of models) {
        try {
            results.push({ model, ms: await warmUp(model) });
        } catch (e) {
            results.push({ model, error: e.message });
        }
    }
    return results;
}
