/**
 * 훈련 기록.
 *
 * 이 게임의 목적은 이기는 게 아니라 기억력을 늘리는 것이다.
 * 그래서 한 판의 승패보다 "지난번보다 나아지고 있나" 를 보여주는 쪽이 맞다.
 *
 * 브라우저 localStorage 에만 쌓는다. 서버로 나가지 않는다.
 *
 * game.js 가 인라인 onclick 을 쓰는 클래식 스크립트라 여기도 모듈로 만들지 않는다.
 * (모듈이면 함수가 전역에 없어서 onclick 이 전부 깨진다)
 */

const HISTORY_KEY = 'market_ai_history';
const MAX_KEPT = 300;

/** 하루 경계는 현지 시각 기준 */
function today() {
    const d = new Date();
    return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
        .map(n => String(n).padStart(2, '0')).join('-');
}

function loadHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        return [];   // 저장값이 깨져 있으면 없던 것으로 본다
    }
}

/**
 * 한 판을 기록한다.
 * @param {{topic: string, score: number, outcome: string, stumbleAt: number|null}} game
 *   score     : 그 판에서 쌓은 단어 수
 *   outcome   : 'win' | 'wrong' | 'timeout' | 'offtopic'
 *   stumbleAt : 몇 번째 단어에서 무너졌는지 (1부터). 이겼으면 null
 */
function recordGame(game) {
    const history = loadHistory();
    history.push({
        d: today(),
        t: String(game.topic || '').slice(0, 20),
        s: Number(game.score) || 0,
        o: game.outcome,
        m: game.stumbleAt == null ? null : Number(game.stumbleAt),
    });
    // 오래된 것부터 버린다
    while (history.length > MAX_KEPT) history.shift();

    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        // 저장 공간이 없으면 이번 판 기록은 포기한다. 게임은 계속돼야 한다.
    }
    return summarize(history);
}

/** 화면에 보여줄 값들을 뽑는다 */
function summarize(history = loadHistory()) {
    const day = today();
    const todayGames = history.filter(g => g.d === day);
    const recent = history.slice(-10);

    return {
        played: history.length,
        best: history.reduce((m, g) => Math.max(m, g.s), 0),
        todayPlayed: todayGames.length,
        todayBest: todayGames.reduce((m, g) => Math.max(m, g.s), 0),
        recentAvg: recent.length
            ? Math.round((recent.reduce((a, g) => a + g.s, 0) / recent.length) * 10) / 10
            : 0,
        trend: trendOf(history),
        stumble: stumbleRange(history),
        wins: history.filter(g => g.o === 'win').length,
    };
}

/**
 * 최근 5판이 그 앞 5판보다 나아졌는지.
 * 판이 적을 때는 아무 말도 하지 않는다 — 없는 추세를 지어내면 안 된다.
 */
function trendOf(history) {
    if (history.length < 6) return null;
    const recent = history.slice(-5);
    const before = history.slice(-10, -5);
    if (!before.length) return null;

    const avg = list => list.reduce((a, g) => a + g.s, 0) / list.length;
    const diff = avg(recent) - avg(before);
    if (Math.abs(diff) < 0.5) return { dir: 'flat', diff: 0 };
    return { dir: diff > 0 ? 'up' : 'down', diff: Math.round(Math.abs(diff) * 10) / 10 };
}

/**
 * 주로 몇 번째에서 무너지는지.
 * 훈련에서 제일 쓸모 있는 정보다 — 다음 판에 어디를 조심할지 알려준다.
 */
function stumbleRange(history) {
    const points = history.map(g => g.m).filter(n => typeof n === 'number' && n > 0);
    if (points.length < 3) return null;

    const sorted = [...points].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    const low = Math.max(1, mid - 1);
    const high = mid + 1;
    return { low, high, samples: points.length };
}
