/* =========================================
   상태값
   - entries : [{ word, by }] 나와 AI 가 함께 쌓은 단어. 플레이 중에는 화면에 노출하지 않는다.
   - cursor  : 이번 내 차례에서 지금 입력할 위치 (0부터)
   - phase   : 'me' | 'judging' | 'ai' | 'reveal' | 'over'
========================================= */
let entries = [];
let cursor = 0;
let topic = '';
let phase = 'idle';
let session = 0;          // 새 게임을 누르면 올라간다. 늦게 도착한 응답을 버리는 데 쓴다.
let lastMiss = null;      // 암송을 틀렸을 때 { index, typed, answer }
let lastVerdict = null;   // 심판이 탈락시켰을 때 { word, reason }
let pendingRetry = null;  // 통신이 실패했을 때 다시 시도할 동작

/*
 * 모드
 *   'ai'     AI 와 번갈아 둔다. 심판이 주제 적합성을 본다.
 *   'solo'   혼자 단어를 쌓는다. 서버도 AI 도 쓰지 않는다.
 *   'number' 정해진 범위에서 숫자가 하나씩 제시된다. 외우기만 하면 된다.
 */
let mode = 'ai';
let pendingNumber = null;   // 숫자 모드에서 지금 제시 중인 숫자
let retryCount = 0;         // 이번 판에서 '이어하기' 를 쓴 횟수
let lastReason = '';        // 마지막 게임 오버 사유

// 설정값 (기본값 : 라이트 테마 / 제한 시간 꺼짐 / 입력 1개당 5초)
let settings = { timerEnabled: false, seconds: 5, mode: 'ai', min: 1, max: 99 };
let theme = 'light';

// 설정 패널에서 저장을 누르기 전까지의 임시값
let draftTimerEnabled = false;
let draftTheme = 'light';

// 타이머
let timerHandle = null;
let deadline = 0;

const SETTINGS_KEY = 'market_settings';
const THEME_KEY = 'theme';   // 다른 게임과 같은 키를 써서 테마를 함께 맞춘다

const $ = id => document.getElementById(id);

/* -----------------------------------------
   서버 통신 : API 키는 서버에만 있고 여기로 오지 않는다
----------------------------------------- */
async function api(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('서버 오류 (' + res.status + ')'));
    return data;
}

/* -----------------------------------------
   테마
----------------------------------------- */
function loadTheme() {
    theme = (localStorage.getItem(THEME_KEY) === 'dark') ? 'dark' : 'light';
    draftTheme = theme;
    applyTheme(theme);
}

function applyTheme(value) {
    document.documentElement.classList.toggle('dark-theme', value === 'dark');
}

// 설정 패널에서 테마를 고르면 저장 전에도 바로 미리 보여준다
function pickTheme(value) {
    draftTheme = value;
    applyTheme(value);
    syncSettingsUI();
}

/* -----------------------------------------
   설정 불러오기 / 저장
----------------------------------------- */
function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (saved && typeof saved === 'object') {
            settings.timerEnabled = !!saved.timerEnabled;
            const sec = parseInt(saved.seconds, 10);
            if (!isNaN(sec) && sec >= 1 && sec <= 60) settings.seconds = sec;
        }
    } catch (e) {
        // 저장값이 깨져 있으면 기본값을 그대로 사용
    }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(THEME_KEY, theme);
}

function openSettings() {
    stopInputTimer();   // 설정을 보는 동안에는 시간이 흐르지 않게 멈춘다
    draftTimerEnabled = settings.timerEnabled;
    draftTheme = theme;
    $('sec-input').value = settings.seconds;
    syncSettingsUI();
    $('settings-panel').classList.add('open');
    $('overlay').classList.add('open');
}

function closeSettings() {
    $('settings-panel').classList.remove('open');
    $('overlay').classList.remove('open');

    applyTheme(theme);   // 저장하지 않고 닫았다면 미리보기를 되돌린다

    startInputTimer();   // 내 차례일 때만 다시 흐른다
    if (phase === 'me') focusInput();
}

function toggleTimerSwitch() {
    draftTimerEnabled = !draftTimerEnabled;
    syncSettingsUI();
}

// 스위치 모양, 테마 선택 상태, 초 입력칸 활성화 여부를 화면에 반영
function syncSettingsUI() {
    $('timer-switch').classList.toggle('on', draftTimerEnabled);
    $('sec-row').classList.toggle('disabled', !draftTimerEnabled);
    $('theme-light').classList.toggle('active', draftTheme === 'light');
    $('theme-dark').classList.toggle('active', draftTheme === 'dark');
}

function applySettings() {
    const parsed = parseInt($('sec-input').value, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 60) {
        alert('제한 시간은 1초 ~ 60초 사이로 입력해주세요.');
        return;
    }
    settings.timerEnabled = draftTimerEnabled;
    settings.seconds = parsed;
    theme = draftTheme;
    saveSettings();
    closeSettings();   // 바뀐 설정으로 타이머가 여기서 다시 시작된다
}

/* -----------------------------------------
   모드
----------------------------------------- */
function pickMode(value) {
    mode = ['ai', 'solo', 'number'].includes(value) ? value : 'ai';
    settings.mode = mode;
    saveSettings();
    syncModeUI();

    const target = $(mode === 'number' ? 'min-input' : 'topic-input');
    target.focus();
    target.select();
}

/** 시작 화면을 지금 고른 모드에 맞게 바꾼다 */
function syncModeUI() {
    const isNum = (mode === 'number');
    const isAi = (mode === 'ai');

    for (const m of ['ai', 'solo', 'number']) {
        $('mode-' + m).classList.toggle('active', mode === m);
    }
    $('word-setup').classList.toggle('hidden', isNum);
    $('number-setup').classList.toggle('hidden', !isNum);

    // 주제 추천과 주제 검증은 서버가 필요하다. 혼자 하는 모드에서는 감춘다.
    $('topic-tools').classList.toggle('hidden', !isAi);
    if (!isAi) {
        $('topic-chips').innerHTML = '';
        $('topic-status').classList.add('hidden');
    }

    $('start-emoji').innerText = isNum ? '🔢' : (isAi ? '🤖' : '📝');
    $('start-desc').innerHTML = isNum
        ? '정해진 범위에서 숫자가 하나씩 제시돼요.<br>제시된 숫자를 <b>처음부터 순서대로 다시 입력</b>하면<br>다음 숫자가 나옵니다.'
        : isAi
            ? 'AI 와 <b>번갈아</b> 단어를 쌓습니다.<br>앞의 단어를 <b>순서대로 다시 입력</b>한 뒤 새 단어를 하나 추가하세요.<br>단어가 주제에 맞는지는 <b>심판 AI</b> 가 판정합니다.'
            : '주제를 정하고 단어를 하나씩 이어 붙여 보세요.<br>앞에서 넣은 단어를 <b>순서대로 다시 입력</b>한 뒤<br>새 단어를 하나 추가하면 됩니다.';

    renderHomeStats();
}

/** 모드에 따라 달라지는 표기 */
function unitLabel() {
    return (mode === 'number') ? '숫자' : '단어';
}

/** 정해진 범위에서 숫자를 하나 뽑는다 (양 끝값 포함) */
function drawNumber() {
    return settings.min + Math.floor(Math.random() * (settings.max - settings.min + 1));
}

/** 숫자 범위 입력칸을 읽는다. 문제가 있으면 false */
function readNumberRange() {
    const lo = parseInt($('min-input').value, 10);
    const hi = parseInt($('max-input').value, 10);

    if (isNaN(lo) || isNaN(hi) || lo < 0 || hi > 9999) {
        alert('숫자 범위는 0 ~ 9999 사이로 입력해주세요.');
        $('min-input').focus();
        return false;
    }
    if (lo > hi) {
        alert('앞쪽에 더 작은 숫자를 넣어주세요.');
        $('min-input').focus();
        $('min-input').select();
        return false;
    }
    settings.min = lo;
    settings.max = hi;
    return true;
}

/** 플레이 화면을 모드에 맞게 맞춘다 */
function syncPlayModeUI() {
    const isNum = (mode === 'number');
    const input = $('word-input');

    document.querySelector('.topic-suffix').innerText = isNum ? ' 사이의 숫자' : '에 가면~';
    $('counter-unit').innerText = '번째 ' + unitLabel();

    // 차례 표시줄과 AI 단어 공개 카드는 AI 대결에서만 쓴다
    $('turn-bar').classList.toggle('hidden', mode !== 'ai');

    input.placeholder = isNum ? '숫자 입력' : '단어 입력';
    input.maxLength = isNum ? 4 : 30;
    if (isNum) input.setAttribute('inputmode', 'numeric');
    else input.removeAttribute('inputmode');
}

/* -----------------------------------------
   주제 추천
----------------------------------------- */
async function askTopics() {
    const btn = $('suggest-btn');
    const box = $('topic-chips');
    btn.disabled = true;
    btn.innerText = '🎲 고르는 중…';
    box.innerHTML = '';

    try {
        const res = await api('/api/topics', {});
        const list = res.topics || [];
        box.innerHTML = list.length
            ? list.map(function (t) {
                return '<button class="topic-chip" onclick="pickTopic(this)" '
                    + 'data-topic="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>';
            }).join('')
            : '<div class="empty-note">주제를 떠올리지 못했어요. 다시 눌러주세요.</div>';
    } catch (err) {
        box.innerHTML = '<div class="empty-note">' + escapeHtml(err.message) + '</div>';
    } finally {
        btn.disabled = false;
        btn.innerText = '🎲 AI에게 추천받기';
    }
}

function pickTopic(el) {
    $('topic-input').value = el.dataset.topic;
    $('topic-status').classList.add('hidden');
    $('topic-input').focus();
}

/* -----------------------------------------
   게임 진행
----------------------------------------- */
async function startNewGame() {
    if (mode === 'number') {
        if (!readNumberRange()) return;
        topic = settings.min + ' ~ ' + settings.max;
    } else {
        const input = $('topic-input');
        const value = input.value.trim();
        if (!value) {
            shakeTopic();
            return;
        }
        // 주제가 장소인지는 AI 대결에서만 확인한다.
        // 혼자 하는 모드는 서버 없이도 돌아가야 하고, 판정할 심판도 없다.
        if (mode === 'ai' && !(await checkTopic(value))) return;
        topic = value;
    }

    settings.mode = mode;
    saveSettings();

    session++;
    entries = [];
    cursor = 0;
    lastMiss = null;
    lastVerdict = null;
    pendingRetry = null;
    pendingNumber = null;
    retryCount = 0;
    lastReason = '';
    phase = 'me';

    syncPlayModeUI();

    $('topic-label').innerText = topic;
    $('word-input').value = '';
    $('result-modal').classList.remove('open');
    $('start-screen').classList.add('hidden');
    $('play-screen').classList.remove('hidden');

    showFeedback('');
    showMyTurn();
    updateStatusUI();
    updateCounts();
    startInputTimer();
    focusActiveControl();
}

/** 주제를 서버에 물어본다. 통과하면 true */
async function checkTopic(value) {
    const box = $('topic-status');
    const btn = $('start-btn');

    box.className = 'topic-status checking';
    box.innerText = '주제를 확인하는 중…';
    btn.disabled = true;

    try {
        const res = await api('/api/topic-check', { topic: value });
        if (res.ok) {
            box.classList.add('hidden');
            return true;
        }
        box.className = 'topic-status bad';
        box.innerHTML = '이 주제로는 게임을 만들기 어려워요.<br>'
            + escapeHtml(res.reason || '')
            + '<br><b>장소</b>를 골라주세요. 예) 시장, 목욕탕, 냉장고, 서랍';
        shakeTopic();
        return false;
    } catch (err) {
        // 확인에 실패했다고 게임을 막지는 않는다. 알리고 그냥 진행한다.
        box.className = 'topic-status checking';
        box.innerText = '주제 확인을 건너뛰었어요 (' + err.message + ')';
        return true;
    } finally {
        btn.disabled = false;
    }
}

function shakeTopic() {
    const input = $('topic-input');
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 400);
    input.focus();
}

// 새 게임 : 주제부터 다시 정할 수 있도록 시작 화면으로 되돌린다
function restartGame() {
    if (phase !== 'idle' && phase !== 'over' && entries.length > 0) {
        if (!confirm('진행 중인 게임을 끝내고 새로 시작할까요?')) return;
    }
    stopInputTimer();
    session++;              // 아직 날아오고 있는 응답은 이제 무시된다
    phase = 'idle';
    entries = [];
    cursor = 0;
    lastMiss = null;
    lastVerdict = null;
    pendingRetry = null;

    $('result-modal').classList.remove('open');
    $('play-screen').classList.add('hidden');
    $('start-screen').classList.remove('hidden');

    renderHomeStats();

    const topicInput = $('topic-input');
    topicInput.value = topic;
    topicInput.focus();
    topicInput.select();
}

// 비교용 정규화 : 앞뒤 공백 제거, 중간 공백은 하나로, 영문 대소문자 무시
function normalize(str) {
    return String(str).trim().replace(/\s+/g, ' ').toLowerCase();
}

function submitWord() {
    if (phase !== 'me') return;

    const input = $('word-input');
    const value = input.value.trim();
    if (!value) {
        shakeInput();
        return;
    }

    // (1) 기억 확인 구간 : 앞서 나온 단어를 순서대로 다시 입력하는 중
    if (cursor < entries.length) {
        if (normalize(value) === normalize(entries[cursor].word)) {
            cursor++;
            input.value = '';
            flashOk();
            showFeedback('');
            updateStatusUI();
            startInputTimer();
        } else {
            lastMiss = { index: cursor, typed: value, answer: entries[cursor].word };
            gameOver('wrong');
        }
        return;
    }

    // (2) 새 단어 추가 구간 : 중복은 코드가 먼저 막는다 (패배가 아니라 경고)
    if (entries.some(e => normalize(e.word) === normalize(value))) {
        showFeedback('이미 나온 ' + unitLabel() + '예요!', 'warn');
        shakeInput();
        input.select();
        startInputTimer();
        return;
    }

    // 혼자 하는 모드에는 심판이 없다. 바로 채택한다.
    if (mode === 'solo') {
        entries.push({ word: value, by: 'me' });
        cursor = 0;
        input.value = '';
        flashOk();
        showFeedback(entries.length + '개 완성! 처음부터 다시 떠올려보세요', 'ok');
        updateStatusUI();
        updateCounts();
        startInputTimer();
        return;
    }

    judgeMyWord(value);
}

/** 숫자 모드 : 제시된 숫자를 확인하고 회상 구간으로 넘어간다 */
function confirmNumber(auto) {
    if (phase !== 'me' || mode !== 'number' || pendingNumber === null) return;

    entries.push({ word: String(pendingNumber), by: 'ai' });
    pendingNumber = null;
    cursor = 0;
    $('word-input').value = '';
    showFeedback(entries.length + '개 완성! 처음부터 순서대로 다시 입력하세요', 'ok');
    updateStatusUI();
    updateCounts();
    startInputTimer();
    if (!auto) focusActiveControl();
}

/** 이어하기 : 오타로 끝났을 때 그 자리부터 다시 */
function resumeGame() {
    retryCount++;
    phase = 'me';

    $('result-modal').classList.remove('open');
    $('word-input').value = '';

    showFeedback('다시 도전! ' + (cursor + 1) + '번째 ' + unitLabel() + '부터 입력하세요', 'warn');
    showMyTurn();
    updateStatusUI();
    startInputTimer();
    focusActiveControl();
}

/** 결과 모달의 목록 여닫기 (이어할 수 있으니 기본은 접힌 상태) */
function toggleWordList() {
    const list = $('result-words');
    const opened = !list.classList.toggle('hidden');
    $('reveal-toggle').innerText = opened
        ? '📜 목록 접기 ▲'
        : '📜 쌓았던 ' + unitLabel() + ' 보기 ▼';
}

// 내가 낸 새 단어를 심판 AI 에게 보낸다
async function judgeMyWord(word) {
    const token = session;
    stopInputTimer();
    phase = 'judging';
    showWaiting('⚖️ 심판 AI 가 확인 중…', '"' + word + '" 이(가) 주제에 맞는지 보고 있어요.');

    try {
        const res = await api('/api/judge', {
            topic,
            word,
            usedWords: entries.map(e => e.word),
        });
        if (token !== session) return;

        if (res.duplicate) {
            phase = 'me';
            showMyTurn();
            showFeedback('이미 나온 단어예요!', 'warn');
            shakeInput();
            $('word-input').select();
            startInputTimer();
            return;
        }

        if (!res.valid) {
            lastVerdict = { word: word, reason: res.reason };
            gameOver('offtopic');
            return;
        }

        entries.push({ word: word, by: 'me' });
        $('word-input').value = '';
        cursor = 0;
        updateCounts();
        runAiTurn();
    } catch (err) {
        if (token !== session) return;
        showError(err, () => judgeMyWord(word));
    }
}

// AI 차례 : 생성 → 검수 → 심판 루프는 서버 안에서 돈다
async function runAiTurn() {
    const token = session;
    phase = 'ai';
    showWaiting('🤖 AI 가 단어를 고르는 중…', '생성 → 검수 → 심판 순서로 확인하고 있어요.');

    try {
        const res = await api('/api/ai-turn', {
            topic,
            usedWords: entries.map(e => e.word),
        });
        if (token !== session) return;

        if (res.outcome === 'exhausted') {
            gameOver('win');
            return;
        }

        entries.push({ word: res.word, by: 'ai' });
        updateCounts();
        showReveal(res.word);
    } catch (err) {
        if (token !== session) return;
        showError(err, runAiTurn);
    }
}

function showReveal(word) {
    phase = 'reveal';
    $('my-turn-area').classList.add('hidden');
    $('waiting-area').classList.add('hidden');
    $('reveal-area').classList.remove('hidden');
    $('reveal-word').innerText = word;
    updateTurnBar();

    // 확인 버튼으로 포커스를 옮긴다.
    // 문서 전체에서 엔터를 받고는 있지만, 포커스가 숨겨진 입력칸에 남아 있으면
    // 브라우저나 한글 입력기 상태에 따라 엔터가 그쪽에서 먹힐 수 있다.
    // 버튼에 포커스가 있으면 엔터가 곧 클릭이라 어떤 경로로도 넘어간다.
    $('reveal-ok').focus();
}

// AI 단어를 확인했다 → 다시 내 차례. 처음부터 전부 암송한다.
function closeReveal() {
    // 엔터가 두 경로(버튼 클릭 + 문서 리스너)로 동시에 들어올 수 있다.
    // 두 번 돌아도 탈이 없도록 막는다.
    if (phase !== 'reveal') return;

    phase = 'me';
    cursor = 0;
    showMyTurn();
    showFeedback('');
    updateStatusUI();
    startInputTimer();
    focusInput();
}

/* -----------------------------------------
   화면 전환
----------------------------------------- */
function showMyTurn() {
    $('my-turn-area').classList.remove('hidden');
    $('waiting-area').classList.add('hidden');
    $('reveal-area').classList.add('hidden');
    updateTurnBar();
}

function showWaiting(label, sub) {
    $('my-turn-area').classList.add('hidden');
    $('reveal-area').classList.add('hidden');
    $('waiting-area').classList.remove('hidden');
    $('waiting-label').innerText = label;
    $('waiting-sub').innerText = sub || '';
    $('retry-btn').classList.add('hidden');
    $('waiting-area').querySelector('.dots').classList.remove('hidden');
    updateTurnBar();
}

// 통신이 실패해도 게임을 끝내지 않는다. 같은 자리에서 다시 시도할 수 있게 한다.
function showError(err, retryFn) {
    pendingRetry = retryFn;
    $('waiting-label').innerText = '⚠️ 연결에 실패했어요';
    $('waiting-sub').innerText = err.message;
    $('waiting-area').querySelector('.dots').classList.add('hidden');
    $('retry-btn').classList.remove('hidden');
}

function retryPending() {
    if (!pendingRetry) return;
    const fn = pendingRetry;
    pendingRetry = null;
    $('retry-btn').classList.add('hidden');
    $('waiting-area').querySelector('.dots').classList.remove('hidden');
    $('waiting-label').innerText = '다시 시도하는 중…';
    fn();
}

function updateCounts() {
    $('count-me').innerText = entries.filter(e => e.by === 'me').length;
    $('count-ai').innerText = entries.filter(e => e.by === 'ai').length;
}

/** 차례 표시줄은 AI 대결에서만 뜻이 있다 */
function updateTurnBar() {
    if (mode !== 'ai') return;
    const mine = (phase === 'me' || phase === 'judging');
    $('turn-me').classList.toggle('active', mine);
    $('turn-ai').classList.toggle('active', phase === 'ai' || phase === 'reveal');
}

// 지금 몇 번째 단어를 입력할 차례인지 화면에 표시
function updateStatusUI() {
    const hint = $('phase-hint');
    const reveal = $('num-reveal');
    const inputRow = $('input-row');
    $('word-index').innerText = cursor + 1;

    const isNewWord = cursor >= entries.length;
    hint.classList.toggle('is-new', isNewWord);

    if (isNewWord && mode === 'number') {
        // 새 차례가 되면 숫자를 하나 뽑아 보여주고, 입력창 대신 확인 버튼만 둔다
        if (pendingNumber === null) pendingNumber = drawNumber();
        $('num-reveal-val').innerText = pendingNumber;
        reveal.classList.remove('hidden');
        inputRow.classList.add('hidden');
        hint.innerText = '✨ 제시된 숫자를 확인하세요';
        updateTurnBar();
        return;
    }

    reveal.classList.add('hidden');
    inputRow.classList.remove('hidden');

    if (isNewWord) {
        hint.innerText = entries.length === 0
            ? '✨ 첫 ' + unitLabel() + '를 입력하세요'
            : '✨ 새 ' + unitLabel() + '를 추가하세요';
    } else if (mode === 'ai') {
        // 누가 낸 단어인지만 알려준다. 단어 자체는 끝까지 감춘다.
        hint.innerText = '기억을 떠올려 입력하세요 · '
            + (entries[cursor].by === 'ai' ? 'AI 가 낸 단어' : '내가 낸 단어');
    } else {
        hint.innerText = '기억을 떠올려 입력하세요';
    }
    updateTurnBar();
}

/* -----------------------------------------
   게임 종료
----------------------------------------- */
function gameOver(reason) {
    stopInputTimer();
    phase = 'over';

    const score = entries.length;
    const isWin = (reason === 'win');

    // 몇 번째에서 무너졌는지 (1부터). 이 값이 훈련 기록에서 제일 쓸모 있다.
    const stumbleAt = isWin ? null
        : (reason === 'wrong' ? lastMiss.index + 1 : cursor + 1);

    lastReason = reason;
    const before = summarize(mode);
    const stats = recordGame({ topic, score, outcome: reason, stumbleAt, mode });
    // 첫 판은 언제나 "최고 기록" 이 되지만 넘어설 이전 기록이 없어서 공허하다.
    // 비교 대상이 있을 때만 축하한다.
    const isRecord = !isWin && score > 0 && before.played > 0 && score > before.best;

    renderResultHeader(reason, isWin, isRecord);
    renderResultReason(reason, isWin);

    $('result-score').innerText = score;
    $('result-avg').innerText = stats.recentAvg;
    $('result-best').innerText = stats.best;

    renderCoach(stats, isWin, isRecord, stumbleAt);
    renderWordList(reason);

    // 이어하기는 '기억을 놓친' 경우에만 준다.
    // 심판에게 탈락한 판(offtopic)은 다른 단어를 내면 되는 것이라 이어할 자리가 없다.
    const canResume = (reason === 'wrong' || reason === 'timeout');
    $('resume-btn').classList.toggle('hidden', !canResume);

    const retryBox = $('retry-note');
    retryBox.innerText = '🔁 이어하기 ' + retryCount + '회 사용';
    retryBox.classList.toggle('hidden', retryCount === 0);

    // 이어서 할 수 있으니 목록은 접어둔 채로 둔다
    $('result-words').classList.add('hidden');
    $('reveal-toggle').innerText = '📜 쌓았던 ' + unitLabel() + ' 보기 ▼';
    $('num-reveal').classList.add('hidden');

    $('result-modal').classList.add('open');
}

/* 이기지 못한 판을 "실패" 로 부르지 않는다. 훈련에서는 어디까지 갔는지가 성과다. */
function renderResultHeader(reason, isWin, isRecord) {
    let emoji = '🧠';
    let title = '여기까지 왔어요';

    if (isWin) {
        emoji = '🏆';
        title = 'AI 가 손을 들었어요';
    } else if (isRecord) {
        emoji = '🎉';
        title = '최고 기록!';
    }

    $('result-emoji').innerText = emoji;
    $('result-title').innerText = title;
    $('result-title').classList.toggle('win', isWin || isRecord);
}

function renderResultReason(reason, isWin) {
    const reasonBox = $('result-reason');
    const verdictBox = $('result-verdict');
    verdictBox.classList.add('hidden');

    if (isWin) {
        reasonBox.innerHTML = 'AI 가 <b>' + escapeHtml(topic) + '</b> 주제에서<br>'
            + '더 낼 수 있는 새 단어를 찾지 못했어요.';
    } else if (reason === 'timeout') {
        reasonBox.innerHTML = '⏱️ ' + (cursor + 1) + '번째 ' + unitLabel() + '에서 시간이 다 됐어요.';
    } else if (reason === 'offtopic') {
        reasonBox.innerHTML = '심판 AI 가 <b>' + escapeHtml(lastVerdict.word) + '</b> 을(를)<br>'
            + '주제에 맞지 않는다고 봤어요.';
        verdictBox.innerText = '심판 사유 : ' + (lastVerdict.reason || '(사유 없음)');
        verdictBox.classList.remove('hidden');
    } else {
        reasonBox.innerHTML = (lastMiss.index + 1) + '번째가 <b>' + escapeHtml(lastMiss.answer) + '</b> 였는데<br>'
            + '<b>' + escapeHtml(lastMiss.typed) + '</b> 을(를) 입력했어요.';
    }
}

/* 다음 판에 무엇을 노리면 되는지 한 줄로 알려준다 */
function renderCoach(stats, isWin, isRecord, stumbleAt) {
    const box = $('result-coach');
    const lines = [];

    if (isRecord) {
        lines.push('이전 최고를 넘었어요. 이 주제로 한 번 더 가면 더 늘어나요.');
    } else if (isWin) {
        lines.push('주제를 바닥냈어요. 다음엔 더 넓은 주제로 가보세요.');
    }

    // 훈련에 쓸모 있는 순서로 담는다. 다음 판에 뭘 노릴지 알려주는 게 먼저다.
    if (stats.stumble && !isWin) {
        const { low, high } = stats.stumble;
        lines.push(`보통 ${low}~${high}번째에서 놓쳐요.`
            + (stumbleAt && stumbleAt > high ? ' 이번엔 그보다 멀리 갔어요.' : ''));
    }

    if (stats.trend && stats.trend.dir !== 'flat') {
        lines.push(stats.trend.dir === 'up'
            ? `최근 5판이 그 전보다 평균 ${stats.trend.diff}개 늘었어요.`
            : `최근 5판이 그 전보다 평균 ${stats.trend.diff}개 줄었어요. 쉬었다 하는 것도 방법이에요.`);
    }

    if (stats.todayPlayed > 1) {
        lines.push(`오늘 ${stats.todayPlayed}판째, 오늘 최고는 ${stats.todayBest}개예요.`);
    }

    // 모달이 길어지면 정작 봐야 할 단어 목록이 화면 밖으로 밀린다
    box.innerHTML = lines.slice(0, 3).map(escapeHtml).join('<br>');
    box.classList.toggle('hidden', lines.length === 0);
}

// 숨겨두었던 단어 목록은 게임이 끝난 지금 공개한다
function renderWordList(reason) {
    const listBox = $('result-words');
    if (entries.length === 0) {
        listBox.innerHTML = '<div class="empty-note">아직 쌓은 단어가 없어요.</div>';
        return;
    }
    listBox.innerHTML = entries.map(function (e, i) {
        const missed = (reason === 'wrong' && lastMiss.index === i) ? ' missed' : '';
        const byAi = (e.by === 'ai' && !missed) ? ' by-ai' : '';
        // 누가 냈는지는 AI 대결에서만 뜻이 있다
        const who = mode === 'ai'
            ? '<span class="who">' + (e.by === 'ai' ? '🤖' : '🙋') + '</span>'
            : '';
        return '<div class="word-chip' + missed + byAi + '">'
            + '<span class="no">' + (i + 1) + '</span>' + who
            + escapeHtml(e.word) + '</div>';
    }).join('');
}

/* 시작 화면에 지금까지의 훈련 기록을 보여준다 */
function renderHomeStats() {
    const stats = summarize(mode);
    const strip = $('home-stats');
    const note = $('home-trend');

    if (stats.played === 0) {
        strip.classList.add('hidden');
        note.classList.add('hidden');
        return;
    }

    $('home-today').innerText = stats.todayPlayed + '판';
    $('home-avg').innerText = stats.recentAvg;
    $('home-best').innerText = stats.best;
    strip.classList.remove('hidden');

    const parts = [];
    if (stats.trend && stats.trend.dir === 'up') parts.push(`최근 평균이 <b>${stats.trend.diff}개</b> 올랐어요`);
    if (stats.stumble) parts.push(`보통 <b>${stats.stumble.low}~${stats.stumble.high}번째</b>에서 놓쳐요`);
    if (stats.wins) parts.push(`AI 를 <b>${stats.wins}번</b> 이겼어요`);

    note.innerHTML = parts.join(' · ');
    note.classList.toggle('hidden', parts.length === 0);
}

// 입력한 단어를 그대로 화면에 넣기 전에 특수문자를 안전하게 바꿔준다
function escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, function (ch) { return map[ch]; });
}

/* -----------------------------------------
   입력 1개당 제한 시간 : 내 차례에만 흐른다
----------------------------------------- */
function startInputTimer() {
    stopInputTimer();

    const wrap = $('timer-wrap');
    if (!settings.timerEnabled || phase !== 'me') {
        wrap.classList.add('hidden');
        return;
    }

    wrap.classList.remove('hidden');
    deadline = Date.now() + settings.seconds * 1000;
    drawTimer();
    timerHandle = setInterval(drawTimer, 50);
}

function stopInputTimer() {
    if (timerHandle) {
        clearInterval(timerHandle);
        timerHandle = null;
    }
}

function drawTimer() {
    const remain = Math.max(0, deadline - Date.now());
    const ratio = remain / (settings.seconds * 1000);
    const fill = $('timer-fill');

    fill.style.width = (ratio * 100) + '%';
    fill.classList.toggle('urgent', ratio <= 0.3);
    $('timer-text').innerText = (remain / 1000).toFixed(1);

    if (remain <= 0 && phase === 'me') {
        // 숫자 제시 화면은 보기만 하는 단계다. 시간이 다 되면 실패 대신 자동으로 넘긴다.
        if (mode === 'number' && cursor >= entries.length) confirmNumber(true);
        else gameOver('timeout');
    }
}

/* -----------------------------------------
   입력창 보조 효과
----------------------------------------- */
function focusInput() {
    $('word-input').focus();
}

/** 지금 화면에 놓인 조작 요소(입력칸 또는 숫자 확인 버튼)에 포커스를 준다 */
function focusActiveControl() {
    if (mode === 'number' && cursor >= entries.length) $('num-confirm-btn').focus();
    else focusInput();
}

function shakeInput() {
    const input = $('word-input');
    input.classList.remove('shake');
    void input.offsetWidth;   // 애니메이션을 다시 재생시키기 위한 리플로우
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 400);
}

function flashOk() {
    const input = $('word-input');
    input.classList.add('flash-ok');
    setTimeout(() => input.classList.remove('flash-ok'), 220);
}

function showFeedback(msg, type) {
    const box = $('feedback');
    box.innerText = msg || '';
    box.className = 'feedback' + (type ? ' ' + type : '');
}

/* -----------------------------------------
   초기화
----------------------------------------- */
// 엔터로 진행한다. form 을 쓰지 않아야 브라우저 입력 기록에 단어가 남지 않는다.
$('word-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitWord();
    }
});

$('topic-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        startNewGame();
    }
});

// AI 단어 공개 화면에는 입력칸이 없어서 엔터가 갈 곳이 없다.
// 확인 버튼도 엔터로 넘어가도록 문서 전체에서 받는다.
// (설정 패널이 열려 있을 때는 그쪽 엔터를 가로채면 안 된다)
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (phase !== 'reveal') return;
    if ($('settings-panel').classList.contains('open')) return;
    // 한글 입력 중의 엔터는 글자를 확정하는 용도다. 그것까지 가로채면 안 된다.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    closeReveal();
});

// 주제를 고쳐 쓰기 시작하면 이전 안내는 지운다
$('topic-input').addEventListener('input', function () {
    $('topic-status').classList.add('hidden');
});

['min-input', 'max-input'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            startNewGame();
        }
    });
});

$('sec-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        applySettings();
    }
});

// 서버가 어떤 모델로 준비돼 있는지 미리 확인해서, 시작 버튼을 누르기 전에 알려준다
async function checkServer() {
    const box = $('key-notice');
    try {
        const res = await fetch('/api/health');
        const data = await res.json();

        if (!data.ready) {
            box.innerHTML = '⚠️ 아직 준비가 안 됐어요.<br>'
                + (data.problems || []).map(p => '· ' + escapeHtml(p)).join('<br>');
            box.classList.remove('hidden');
            $('start-btn').disabled = true;
            $('suggest-btn').disabled = true;
            return;
        }

        // 준비가 됐다면 어떤 모델이 상대인지 조용히 알려준다
        const g = data.roles && data.roles.generate;
        if (g) $('model-badge').innerText = '상대 : ' + g.model + (data.mock ? ' (목업)' : '');
    } catch (e) {
        box.innerText = '⚠️ 서버에 연결하지 못했습니다. npm start 로 서버를 켰는지 확인해주세요.';
        box.classList.remove('hidden');
    }
}

loadTheme();
loadSettings();

// 지난번에 고른 모드와 숫자 범위를 그대로 되살린다
mode = settings.mode;
$('min-input').value = settings.min;
$('max-input').value = settings.max;
syncModeUI();
checkServer();
$('topic-input').focus();
