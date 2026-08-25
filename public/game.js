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

// 설정값 (기본값 : 라이트 테마 / 제한 시간 꺼짐 / 입력 1개당 5초)
let settings = { timerEnabled: false, seconds: 5 };
let theme = 'light';

// 설정 패널에서 저장을 누르기 전까지의 임시값
let draftTimerEnabled = false;
let draftTheme = 'light';

// 타이머
let timerHandle = null;
let deadline = 0;

const SETTINGS_KEY = 'market_settings';
const BEST_KEY = 'market_ai_bestRecord';
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
    $('topic-input').focus();
}

/* -----------------------------------------
   게임 진행
----------------------------------------- */
function startNewGame() {
    const input = $('topic-input');
    const value = input.value.trim();
    if (!value) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
        input.focus();
        return;
    }

    session++;
    topic = value;
    entries = [];
    cursor = 0;
    lastMiss = null;
    lastVerdict = null;
    pendingRetry = null;
    phase = 'me';

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
    focusInput();
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
        showFeedback('이미 나온 단어예요!', 'warn');
        shakeInput();
        input.select();
        startInputTimer();
        return;
    }

    judgeMyWord(value);
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
}

// AI 단어를 확인했다 → 다시 내 차례. 처음부터 전부 암송한다.
function closeReveal() {
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

function updateTurnBar() {
    const mine = (phase === 'me' || phase === 'judging');
    $('turn-me').classList.toggle('active', mine);
    $('turn-ai').classList.toggle('active', phase === 'ai' || phase === 'reveal');
}

function updateCounts() {
    $('count-me').innerText = entries.filter(e => e.by === 'me').length;
    $('count-ai').innerText = entries.filter(e => e.by === 'ai').length;
}

// 지금 몇 번째 단어를 입력할 차례인지 화면에 표시
function updateStatusUI() {
    const hint = $('phase-hint');
    $('word-index').innerText = cursor + 1;

    const isNewWord = cursor >= entries.length;
    hint.classList.toggle('is-new', isNewWord);

    if (isNewWord) {
        hint.innerText = entries.length === 0 ? '✨ 첫 단어를 입력하세요' : '✨ 새 단어를 추가하세요';
    } else {
        // 누가 낸 단어인지만 알려준다. 단어 자체는 끝까지 감춘다.
        const owner = entries[cursor].by === 'ai' ? 'AI 가 낸 단어' : '내가 낸 단어';
        hint.innerText = '기억을 떠올려 입력하세요 · ' + owner;
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
    let best = parseInt(localStorage.getItem(BEST_KEY), 10);
    if (isNaN(best)) best = 0;
    if (score > best) {
        best = score;
        localStorage.setItem(BEST_KEY, best);
    }

    const isWin = (reason === 'win');
    $('result-emoji').innerText = isWin ? '🏆' : '💥';
    $('result-title').innerText = isWin ? '승리!' : '게임 오버';
    $('result-title').classList.toggle('win', isWin);

    const reasonBox = $('result-reason');
    const verdictBox = $('result-verdict');
    verdictBox.classList.add('hidden');

    if (isWin) {
        reasonBox.innerHTML = 'AI 가 <b>' + escapeHtml(topic) + '</b> 주제에서<br>'
            + '더 낼 수 있는 새 단어를 찾지 못했어요.';
    } else if (reason === 'timeout') {
        reasonBox.innerHTML = '⏱️ <b>시간 초과</b>로 게임이 끝났습니다.<br>'
            + (cursor + 1) + '번째 단어를 입력하지 못했어요.';
    } else if (reason === 'offtopic') {
        reasonBox.innerHTML = '⚖️ 심판 AI 가 <b>' + escapeHtml(lastVerdict.word) + '</b> 을(를)<br>'
            + '주제에 맞지 않는다고 판정했습니다.';
        verdictBox.innerText = '심판 사유 : ' + (lastVerdict.reason || '(사유 없음)');
        verdictBox.classList.remove('hidden');
    } else {
        reasonBox.innerHTML = (lastMiss.index + 1) + '번째 단어를 <b>' + escapeHtml(lastMiss.typed) + '</b>(으)로 입력했어요.<br>'
            + '정답은 <b>' + escapeHtml(lastMiss.answer) + '</b> 였습니다.';
    }

    $('result-score').innerText = score;
    $('result-best').innerText = best;

    // 숨겨두었던 단어 목록은 게임이 끝난 지금 공개한다
    const listBox = $('result-words');
    if (entries.length === 0) {
        listBox.innerHTML = '<div class="empty-note">아직 쌓은 단어가 없어요.</div>';
    } else {
        listBox.innerHTML = entries.map(function (e, i) {
            const missed = (reason === 'wrong' && lastMiss.index === i) ? ' missed' : '';
            const byAi = (e.by === 'ai' && !missed) ? ' by-ai' : '';
            return '<div class="word-chip' + missed + byAi + '">'
                + '<span class="no">' + (i + 1) + '</span>'
                + '<span class="who">' + (e.by === 'ai' ? '🤖' : '🙋') + '</span>'
                + escapeHtml(e.word) + '</div>';
        }).join('');
    }

    $('result-modal').classList.add('open');
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

    if (remain <= 0 && phase === 'me') gameOver('timeout');
}

/* -----------------------------------------
   입력창 보조 효과
----------------------------------------- */
function focusInput() {
    $('word-input').focus();
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
checkServer();
$('topic-input').focus();
