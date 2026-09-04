/**
 * 친구와 하는 모드 (클라이언트).
 *
 * 혼자·AI 모드와 진행 방식이 꽤 다르다 — 차례가 사람들 사이를 돌고, 탈락이 있고,
 * 상태를 서버가 들고 있다. 그래서 game.js 를 건드리지 않고 화면과 코드를 따로 뒀다.
 *
 * 상태는 서버가 SSE 로 밀어 준다. 여기서는 받은 것을 그리기만 한다.
 * 내가 조작하면 POST 로 보내고, 결과는 다시 SSE 로 돌아온다.
 * 화면을 두 곳에서 고치지 않으려는 것이다.
 */

const NAME_KEY = 'market_player_name';

let room = null;        // 서버가 마지막으로 내려준 방 상태
let myId = null;
let myCode = null;
let stream = null;      // EventSource
let roomSeconds = 20;
let roomTimer = null;
let lastSeenEvent = null;

/* -----------------------------------------
   설정 화면
----------------------------------------- */
function pickRoomSeconds(sec) {
    roomSeconds = sec;
    for (const s of [0, 10, 20, 30]) {
        $('sec-' + s).classList.toggle('active', s === sec);
    }
}

function showJoinBox() {
    $('join-box').classList.toggle('hidden');
    if (!$('join-box').classList.contains('hidden')) $('join-code').focus();
}

function myName() {
    const name = $('player-name').value.trim();
    if (name) localStorage.setItem(NAME_KEY, name);
    return name;
}

function roomError(message) {
    const box = $('room-error');
    box.innerText = message || '';
    box.classList.toggle('hidden', !message);
}

/* -----------------------------------------
   방 만들기 · 참가
----------------------------------------- */
async function createRoom(topic, lang) {
    const name = myName();
    if (!name) return roomError('이름을 입력해주세요.'), false;

    roomError('');
    try {
        const res = await api('/api/room/create', { name, topic, lang, seconds: roomSeconds });
        enterRoom(res.playerId, res.room);
        return true;
    } catch (err) {
        roomError(err.message);
        return false;
    }
}

async function joinRoomByCode() {
    const name = myName();
    if (!name) return roomError('이름을 입력해주세요.');
    const code = $('join-code').value.trim();
    if (!/^\d{6}$/.test(code)) return roomError('방 코드는 6자리 숫자예요.');

    roomError('');
    try {
        const res = await api('/api/room/join', { code, name });
        enterRoom(res.playerId, res.room);
    } catch (err) {
        roomError(err.message);
    }
}

async function quickJoinRoom() {
    const name = myName();
    if (!name) return roomError('이름을 입력해주세요.');

    roomError('');
    try {
        const res = await api('/api/room/quick', { name });
        enterRoom(res.playerId, res.room);
    } catch (err) {
        roomError(err.message);
    }
}

function enterRoom(playerId, view) {
    myId = playerId;
    myCode = view.code;
    room = view;
    lastSeenEvent = null;

    $('start-screen').classList.add('hidden');
    openStream();
    render();
}

/* -----------------------------------------
   실시간 전달
----------------------------------------- */
function openStream() {
    closeStream();
    stream = new EventSource('/api/room/stream?code=' + encodeURIComponent(myCode)
        + '&playerId=' + encodeURIComponent(myId));

    stream.onmessage = (e) => {
        try {
            room = JSON.parse(e.data);
            render();
        } catch (err) {
            // 깨진 조각은 버린다. 다음 갱신이 곧 온다.
        }
    };
    // 끊기면 EventSource 가 알아서 다시 붙는다. 따로 할 일이 없다.
}

function closeStream() {
    if (stream) {
        stream.close();
        stream = null;
    }
}

/* -----------------------------------------
   조작
----------------------------------------- */
async function startRoomGame() {
    try {
        await api('/api/room/start', { code: myCode, playerId: myId });
    } catch (err) {
        roomFeedback(err.message, 'warn');
    }
}

async function submitRoomWord() {
    if (!room || room.status !== 'playing' || room.turnPlayerId !== myId) return;

    const input = $('room-input');
    const value = input.value.trim();
    if (!value) return;

    input.disabled = true;
    try {
        await api('/api/room/submit', { code: myCode, playerId: myId, word: value });
        input.value = '';
        roomFeedback('');
    } catch (err) {
        // 중복처럼 다시 내면 되는 것은 경고로만 알린다
        roomFeedback(err.message, 'warn');
        input.select();
    } finally {
        input.disabled = false;
        input.focus();
    }
}

/** 새 낱말을 다 봤다고 알린다 */
async function ackReveal() {
    if (!room || room.status !== 'reveal' || room.revealAcked) return;
    $('reveal-ok').disabled = true;
    try {
        await api('/api/room/ack', { code: myCode, playerId: myId });
    } catch (err) {
        roomFeedback(err.message, 'warn');
    } finally {
        $('reveal-ok').disabled = false;
    }
}

/** 같은 방에서 한 판 더 */
async function restartRoomGame() {
    try {
        await api('/api/room/restart', { code: myCode, playerId: myId });
        $('room-result').classList.remove('open');
    } catch (err) {
        roomFeedback(err.message, 'warn');
    }
}

async function leaveRoom() {
    if (myCode && myId) {
        try { await api('/api/room/leave', { code: myCode, playerId: myId }); } catch (e) { /* 이미 없는 방 */ }
    }
    closeStream();
    stopRoomTimer();
    room = null; myId = null; myCode = null;

    $('room-screen').classList.add('hidden');
    $('room-play').classList.add('hidden');
    $('room-result').classList.remove('open');
    $('start-screen').classList.remove('hidden');
}

/* -----------------------------------------
   그리기
----------------------------------------- */
function render() {
    if (!room) return;

    const waiting = room.status === 'waiting';
    if (waiting) {
        // 방장이 다시 시작하면 모두의 결과 화면이 닫히고 대기실로 돌아온다
        $('room-result').classList.remove('open');
        lastSeenEvent = null;
        roomFeedback('');
    }
    $('room-screen').classList.toggle('hidden', !waiting);
    $('room-play').classList.toggle('hidden', waiting);

    if (waiting) renderWaiting();
    else renderPlaying();

    if (room.status === 'done') renderResult();
}

function renderWaiting() {
    $('room-code-val').innerText = room.code;
    $('room-players').innerHTML = playerRows();

    const n = room.players.length;
    $('room-wait-note').innerHTML = room.youAreHost
        ? (n >= 2
            ? '<b>' + n + '명</b> 모였어요. 시작할 수 있어요.'
            : '친구에게 위 코드를 알려주세요.<br>한 명이라도 더 들어오면 시작할 수 있어요.')
        : '<b>' + n + '명</b> 모였어요.<br>방장이 시작하기를 기다리는 중…';

    const btn = $('room-start-btn');
    btn.classList.toggle('hidden', !room.youAreHost);
    btn.disabled = n < 2;
    btn.innerText = n < 2 ? '▶ 시작 (2명부터)' : '▶ 시작';
}

function renderPlaying() {
    $('room-topic').innerText = room.topic;
    $('room-suffix').innerText = room.lang === 'en' ? '' : '에 가면~';
    $('room-play-players').innerHTML = playerRows();
    $('room-index').innerText = room.cursor + 1;

    const revealing = room.status === 'reveal';
    const myTurn = room.turnPlayerId === myId;
    const turnName = room.players.find(p => p.id === room.turnPlayerId)?.name || '-';
    const isNewWord = room.cursor >= room.wordCount;

    $('room-hint').classList.toggle('is-new', myTurn && isNewWord && !revealing);
    $('room-hint').innerText = room.status === 'done'
        ? '게임이 끝났어요'
        : revealing
            ? (myTurn ? '다음은 내 차례예요' : turnName + ' 님의 차례가 곧 시작돼요')
            : myTurn
                ? (isNewWord
                    ? (room.wordCount === 0 ? '✨ 첫 단어를 입력하세요' : '✨ 새 단어를 추가하세요')
                    : '기억을 떠올려 입력하세요')
                : turnName + ' 님의 차례예요';

    // 새 낱말 공개 — 모두가 외워야 하므로 크게 보여준다.
    // 이 동안에는 차례 시간이 흐르지 않는다. 남이 낸 단어를 외우는 시간에
    // 내 제한 시간이 깎이면 불공정하기 때문이다.
    const reveal = room.lastAdded;
    $('room-reveal').classList.toggle('hidden', !revealing || !reveal);
    if (revealing && reveal) {
        $('room-reveal-cap').innerText = reveal.name + ' 님이 추가한 단어';
        $('room-reveal-word').innerText = reveal.word;
        $('room-reveal-note').innerText = room.revealAcked
            ? '다른 사람을 기다리는 중…'
            : '이 단어도 외워야 해요. 다 외웠으면 확인을 누르세요.';

        const ok = $('reveal-ok');
        ok.disabled = room.revealAcked;
        ok.innerText = room.revealAcked
            ? '✅ 확인함 (' + room.revealAckCount + '/' + room.aliveCount + ')'
            : '✅ 확인했어요';
        if (!room.revealAcked && document.activeElement !== ok) ok.focus();
    }

    // 내 차례가 아니거나 공개 중이면 입력칸을 감춘다
    const canType = myTurn && room.status === 'playing';
    $('room-input-row').classList.toggle('hidden', !canType);
    if (canType && document.activeElement !== $('room-input')) $('room-input').focus();

    showRoomEvent();
    syncRoomTimer();
}

function playerRows() {
    return room.players.map(p => {
        const cls = ['player-row'];
        if (p.isYou) cls.push('is-you');
        if (!p.alive) cls.push('is-out');
        if (p.id === room.turnPlayerId) cls.push('is-turn');

        const tags = [];
        if (p.id === room.hostId) tags.push('방장');
        if (p.isYou) tags.push('나');
        if (!p.alive) tags.push('탈락');
        else if (p.id === room.turnPlayerId) tags.push('차례');

        return '<div class="' + cls.join(' ') + '">'
            + (p.alive ? '🙋' : '💥') + ' ' + escapeHtml(p.name)
            + (tags.length ? '<span class="tag">' + tags.join(' · ') + '</span>' : '')
            + '</div>';
    }).join('');
}

/** 누가 탈락했는지 한 번만 알려준다 */
function showRoomEvent() {
    const ev = room.lastEvent;
    if (!ev) return;

    const key = ev.kind + ':' + ev.playerId + ':' + (ev.at || '') + ':' + (ev.typed || '');
    if (key === lastSeenEvent) return;
    lastSeenEvent = key;

    if (ev.kind === 'left') return roomFeedback(ev.name + ' 님이 나갔어요.', 'warn');

    const who = ev.playerId === myId ? '내가' : ev.name + ' 님이';
    if (ev.reason === 'timeout') roomFeedback('⏱️ ' + who + ' 시간을 넘겨 탈락했어요.', 'warn');
    else if (ev.reason === 'offtopic') roomFeedback('⚖️ ' + who + ' 낸 "' + ev.typed + '" 이(가) 주제에 맞지 않아 탈락했어요.', 'warn');
    else roomFeedback('💥 ' + who + ' ' + ev.at + '번째를 틀렸어요. 정답은 "' + ev.answer + '"', 'warn');
}

function roomFeedback(msg, type) {
    const box = $('room-feedback');
    box.innerText = msg || '';
    box.className = 'feedback' + (type ? ' ' + type : '');
}

/* -----------------------------------------
   제한 시간 : 서버가 준 deadline 을 그리기만 한다
----------------------------------------- */
function syncRoomTimer() {
    stopRoomTimer();

    const turnOn = room.status === 'playing' && room.deadline > 0;
    const revealOn = room.status === 'reveal' && room.revealDeadline > 0;

    $('room-timer-wrap').classList.toggle('hidden', !turnOn);
    $('reveal-timer-wrap').classList.toggle('hidden', !revealOn);

    if (!turnOn && !revealOn) return;
    drawRoomTimer();
    roomTimer = setInterval(drawRoomTimer, 100);
}

function drawRoomTimer() {
    if (!room) return stopRoomTimer();

    // 공개 시간은 방에서 정한 제한 시간과 같다
    if (room.status === 'reveal' && room.revealDeadline) {
        const span = (room.seconds || 60) * 1000;
        const remain = Math.max(0, room.revealDeadline - Date.now());
        $('reveal-timer-fill').style.width = (remain / span * 100) + '%';
        return;
    }

    if (room.status !== 'playing' || !room.deadline) return stopRoomTimer();

    const remain = Math.max(0, room.deadline - Date.now());
    const fill = $('room-timer-fill');
    fill.style.width = (remain / (room.seconds * 1000) * 100) + '%';
    fill.classList.toggle('urgent', remain <= room.seconds * 300);
    $('room-timer-text').innerText = (remain / 1000).toFixed(1);
}

function stopRoomTimer() {
    if (roomTimer) {
        clearInterval(roomTimer);
        roomTimer = null;
    }
}

/* -----------------------------------------
   결과
----------------------------------------- */
function renderResult() {
    stopRoomTimer();
    const winner = room.players.find(p => p.id === room.winnerId);
    const iWon = room.winnerId === myId;

    $('room-result-emoji').innerText = iWon ? '🏆' : (winner ? '🎉' : '🤝');
    $('room-result-title').innerText = iWon ? '내가 이겼어요!' : (winner ? winner.name + ' 님 승리' : '무승부');
    $('room-result-note').innerHTML = '<b>' + room.topic + '</b> 주제로 '
        + '<b>' + room.wordCount + '개</b>까지 쌓았어요.';

    const words = room.words || [];
    $('room-result-words').innerHTML = words.length
        ? words.map((w, i) =>
            '<div class="word-chip"><span class="no">' + (i + 1) + '</span>'
            + escapeHtml(w.word) + '<span class="gloss">' + escapeHtml(w.by) + '</span></div>').join('')
        : '<div class="empty-note">쌓은 단어가 없어요.</div>';

    $('room-again-btn').classList.toggle('hidden', !room.youAreHost);
    $('room-again-note').classList.toggle('hidden', room.youAreHost);
    $('room-result').classList.add('open');
}

/* -----------------------------------------
   초기화
----------------------------------------- */
$('room-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (e.isComposing || e.keyCode === 229) return;
        submitRoomWord();
    }
});

// 공개 화면에는 입력칸이 없어 엔터가 갈 곳이 없다. 엔터를 확인으로 받는다.
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (!room || room.status !== 'reveal' || room.revealAcked) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    ackReveal();
});

$('join-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        joinRoomByCode();
    }
});

// 창을 닫으면 방에서 빠져 준다. 남은 사람이 하염없이 기다리지 않도록.
window.addEventListener('beforeunload', () => {
    if (!myCode || !myId) return;
    navigator.sendBeacon?.('/api/room/leave',
        new Blob([JSON.stringify({ code: myCode, playerId: myId })], { type: 'application/json' }));
});

$('player-name').value = localStorage.getItem(NAME_KEY) || '';
pickRoomSeconds(20);
