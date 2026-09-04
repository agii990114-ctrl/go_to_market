/**
 * 친구와 하는 모드 : 방 관리.
 *
 * 로그인이 없다. 브라우저마다 만든 임의의 id 로 사람을 가른다.
 * 방은 서버 메모리에만 산다. 서버를 다시 켜면 사라진다 — 한 판이 몇 분짜리라
 * 굳이 저장할 이유가 없고, 저장하면 끝난 방을 치우는 일이 새로 생긴다.
 *
 * 화면 갱신은 SSE 로 민다. WebSocket 을 쓸 만큼 주고받을 게 많지 않다.
 * 조작은 평소처럼 POST 로 보내고, 바뀐 결과만 모두에게 내려보낸다.
 *
 * 단어 목록은 절대 내려보내지 않는다. 기억력 게임이라 목록이 보이면 게임이 없다.
 * 누군가 새 단어를 낸 순간에만 그 한 낱말을 모두에게 보여주고(외워야 하니까),
 * 전체 목록은 판이 끝난 뒤에만 공개한다.
 */
import { judge } from './agents.js';
import { normalize } from './game.js';

const MAX_PLAYERS = 10;
const CODE_LENGTH = 6;
const IDLE_MS = 30 * 60 * 1000;      // 이만큼 조용하면 방을 치운다
// 새 낱말을 보여주는 동안에는 차례 시간이 흐르지 않는다.
// 남이 낸 단어를 외우는 시간에 내 제한 시간이 깎이면 불공정하다.
// 살아 있는 사람이 모두 확인을 누르거나, 이 시간이 다 되면 다음 차례가 시작된다.
const REVEAL_CAP_MS = 60 * 1000;     // 제한 시간을 끈 방에서도 무한정 멈춰 있지 않게

const rooms = new Map();   // code -> room

/* -----------------------------------------------------------
   방 만들기 · 들어가기
----------------------------------------------------------- */

function newCode() {
    // 6자리. 앞자리가 0 이면 입력할 때 헷갈리므로 100000 부터 쓴다.
    for (let i = 0; i < 50; i++) {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        if (!rooms.has(code)) return code;
    }
    throw new Error('방 코드를 만들지 못했습니다. 잠시 뒤 다시 시도해주세요.');
}

export function createRoom({ hostName, lang, topic, seconds }) {
    const code = newCode();
    const host = makePlayer(hostName);

    const room = {
        code,
        hostId: host.id,
        lang: lang === 'en' ? 'en' : 'ko',
        topic,
        // 0 이면 제한 시간 없음
        seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(120, Math.max(5, seconds)) : 0,
        status: 'waiting',
        players: [host],
        entries: [],
        turnIndex: 0,
        cursor: 0,
        deadline: 0,
        timer: null,
        lastAdded: null,
        revealAck: new Set(),
        revealDeadline: 0,
        revealTimer: null,
        lastEvent: null,
        winnerId: null,
        listeners: new Set(),
        touched: Date.now(),
    };
    rooms.set(code, room);
    return { room, player: host };
}

function makePlayer(name) {
    return {
        id: 'p' + Math.random().toString(36).slice(2, 10),
        name: String(name || '').trim().slice(0, 12) || '이름없음',
        alive: true,
    };
}

export function joinRoom(code, name) {
    const room = rooms.get(String(code || '').trim());
    if (!room) throw fail('그런 방이 없어요. 코드를 다시 확인해주세요.', 404);
    if (room.status !== 'waiting') throw fail('이미 시작한 방이에요.', 409);
    if (room.players.length >= MAX_PLAYERS) throw fail(`정원(${MAX_PLAYERS}명)이 찼어요.`, 409);

    const player = makePlayer(name);
    room.players.push(player);
    touch(room);
    broadcast(room);
    return { room, player };
}

/** 빠른 참가 : 대기 중이고 자리가 남은 방 하나를 아무거나 고른다 */
export function quickJoin(name) {
    const open = [...rooms.values()].filter(r =>
        r.status === 'waiting' && r.players.length < MAX_PLAYERS);
    if (!open.length) throw fail('지금 들어갈 수 있는 방이 없어요. 방을 만들어보세요.', 404);

    // 사람이 많이 모인 방부터 채운다. 빈 방만 늘어나는 걸 막는다.
    open.sort((a, b) => b.players.length - a.players.length);
    return joinRoom(open[0].code, name);
}

export function getRoom(code) {
    const room = rooms.get(String(code || '').trim());
    if (!room) throw fail('그런 방이 없어요.', 404);
    return room;
}

/* -----------------------------------------------------------
   진행
----------------------------------------------------------- */

export function startGame(code, playerId) {
    const room = getRoom(code);
    if (room.hostId !== playerId) throw fail('방장만 시작할 수 있어요.', 403);
    if (room.status !== 'waiting') throw fail('이미 시작했어요.', 409);
    if (room.players.length < 2) throw fail('한 명이라도 더 들어와야 시작할 수 있어요.', 409);

    room.status = 'playing';
    room.turnIndex = 0;
    room.cursor = 0;
    room.entries = [];
    room.lastEvent = null;
    for (const p of room.players) p.alive = true;

    startTurnTimer(room);
    touch(room);
    broadcast(room);
    return room;
}

/**
 * 판이 끝난 뒤 같은 방에서 다시 시작한다.
 * 방을 유지해야 코드를 다시 알려주고 모이는 수고가 없다.
 */
export function restartGame(code, playerId) {
    const room = getRoom(code);
    if (room.hostId !== playerId) throw fail('방장만 다시 시작할 수 있어요.', 403);
    if (room.status !== 'done') throw fail('아직 판이 끝나지 않았어요.', 409);

    clearTimer(room);
    clearRevealTimer(room);

    room.status = 'waiting';
    room.entries = [];
    room.turnIndex = 0;
    room.cursor = 0;
    room.deadline = 0;
    room.revealDeadline = 0;
    room.lastAdded = null;
    room.lastEvent = null;
    room.winnerId = null;
    room.revealAck = new Set();
    for (const p of room.players) p.alive = true;

    touch(room);
    broadcast(room);
    return room;
}

/** 방장이 주제를 바꾼다 (대기 중에만) */
export function setTopic(code, playerId, topic, lang) {
    const room = getRoom(code);
    if (room.hostId !== playerId) throw fail('방장만 주제를 바꿀 수 있어요.', 403);
    if (room.status !== 'waiting') throw fail('대기 중일 때만 바꿀 수 있어요.', 409);
    room.topic = topic;
    if (lang) room.lang = lang === 'en' ? 'en' : 'ko';
    touch(room);
    broadcast(room);
    return room;
}

function currentPlayer(room) {
    return room.players[room.turnIndex] || null;
}

/**
 * 한 사람의 입력을 처리한다.
 * 암송 구간이면 정확히 맞아야 하고, 새 낱말 구간이면 심판을 거친다.
 */
export async function submit(code, playerId, word, { useJudge = true } = {}) {
    const room = getRoom(code);
    if (room.status !== 'playing') throw fail('진행 중인 게임이 아니에요.', 409);

    const player = currentPlayer(room);
    if (!player || player.id !== playerId) throw fail('아직 차례가 아니에요.', 403);

    const value = String(word || '').trim();
    if (!value) throw fail('낱말을 입력해주세요.', 400);

    // (1) 암송 구간
    if (room.cursor < room.entries.length) {
        const answer = room.entries[room.cursor].word;
        if (normalize(value) !== normalize(answer)) {
            eliminate(room, player, { reason: 'wrong', typed: value, answer, at: room.cursor + 1 });
            return room;
        }
        room.cursor++;
        clearTimer(room);
        startTurnTimer(room);
        touch(room);
        broadcast(room);
        return room;
    }

    // (2) 새 낱말 구간 — 중복은 코드가 먼저 막는다 (탈락이 아니라 경고)
    if (room.entries.some(e => normalize(e.word) === normalize(value))) {
        throw fail('이미 나온 낱말이에요.', 409, { warn: true });
    }

    if (useJudge) {
        const verdict = await judge(room.topic, value, room.lang);
        // 판정 중에 판이 끝났을 수도 있다
        if (room.status !== 'playing' || currentPlayer(room)?.id !== playerId) return room;

        if (!verdict.valid) {
            eliminate(room, player, { reason: 'offtopic', typed: value, judgeReason: verdict.reason });
            return room;
        }
    }

    room.entries.push({ word: value, by: player.id });
    room.cursor = 0;
    room.lastAdded = { word: value, by: player.id, name: player.name };
    if (finishIfOver(room)) return room;
    advanceTurnIndex(room);
    beginReveal(room);
    touch(room);
    broadcast(room);
    return room;
}

/**
 * 새 낱말을 모두에게 보여주는 단계.
 * 이 동안에는 차례 시간이 흐르지 않는다.
 */
function beginReveal(room) {
    clearTimer(room);
    clearRevealTimer(room);

    room.status = 'reveal';
    room.revealAck = new Set();

    const span = room.seconds ? room.seconds * 1000 : REVEAL_CAP_MS;
    room.revealDeadline = Date.now() + span;
    room.deadline = 0;

    room.revealTimer = setTimeout(() => endReveal(room), span);
}

/** 살아 있는 사람이 모두 확인했으면 바로 넘어간다 */
export function ackReveal(code, playerId) {
    const room = getRoom(code);
    if (room.status !== 'reveal') return room;

    const player = room.players.find(p => p.id === playerId);
    if (!player) throw fail('그 방에 없는 사람이에요.', 403);

    room.revealAck.add(playerId);
    touch(room);

    const alive = room.players.filter(p => p.alive);
    if (alive.every(p => room.revealAck.has(p.id))) endReveal(room);
    else broadcast(room);

    return room;
}

function endReveal(room) {
    if (room.status !== 'reveal') return;
    clearRevealTimer(room);

    room.status = 'playing';
    room.lastAdded = null;
    room.revealDeadline = 0;
    startTurnTimer(room);
    broadcast(room);
}

function clearRevealTimer(room) {
    if (room.revealTimer) {
        clearTimeout(room.revealTimer);
        room.revealTimer = null;
    }
}

/** 탈락시키고 다음 사람에게 넘긴다 */
function eliminate(room, player, detail) {
    player.alive = false;
    room.lastEvent = {
        kind: 'eliminated',
        playerId: player.id,
        name: player.name,
        ...detail,
    };
    nextTurn(room);
    touch(room);
    broadcast(room);
}

function nextTurn(room) {
    clearTimer(room);
    clearRevealTimer(room);

    if (finishIfOver(room)) return;
    advanceTurnIndex(room);
    room.status = 'playing';
    startTurnTimer(room);
}

/** 한 명 이하만 남았으면 판을 끝낸다 */
function finishIfOver(room) {
    const alive = room.players.filter(p => p.alive);
    if (alive.length > 1) return false;

    clearTimer(room);
    clearRevealTimer(room);
    room.status = 'done';
    room.winnerId = alive[0]?.id || null;
    room.cursor = 0;
    room.lastAdded = null;
    room.deadline = 0;
    room.revealDeadline = 0;
    broadcast(room);
    return true;
}

function advanceTurnIndex(room) {
    let i = room.turnIndex;
    for (let n = 0; n < room.players.length; n++) {
        i = (i + 1) % room.players.length;
        if (room.players[i].alive) break;
    }
    room.turnIndex = i;
    room.cursor = 0;
}

/* -----------------------------------------------------------
   제한 시간 : 서버가 잰다. 자리를 비운 사람도 넘어가야 하기 때문.
----------------------------------------------------------- */

function startTurnTimer(room) {
    clearTimer(room);
    if (!room.seconds || room.status !== 'playing') {
        room.deadline = 0;
        return;
    }
    room.deadline = Date.now() + room.seconds * 1000;
    room.timer = setTimeout(() => {
        if (room.status !== 'playing') return;
        const player = currentPlayer(room);
        if (player) eliminate(room, player, { reason: 'timeout', at: room.cursor + 1 });
    }, room.seconds * 1000);
}

function clearTimer(room) {
    if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }
}

/* -----------------------------------------------------------
   나가기 · 치우기
----------------------------------------------------------- */

export function leaveRoom(code, playerId) {
    const room = rooms.get(String(code || '').trim());
    if (!room) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    if (room.status === 'waiting') {
        room.players = room.players.filter(p => p.id !== playerId);
        // 방장이 나가면 다음 사람이 방장이 된다
        if (room.hostId === playerId) room.hostId = room.players[0]?.id || null;
        if (!room.players.length) return dropRoom(room);
    } else if (player.alive) {
        // 진행 중이면 탈락 처리. 그 사람 차례였다면 넘긴다.
        player.alive = false;
        room.lastEvent = { kind: 'left', playerId, name: player.name };
        if (currentPlayer(room)?.id === playerId) return nextTurn(room);
        if (room.players.filter(p => p.alive).length <= 1) return nextTurn(room);
    }
    touch(room);
    broadcast(room);
}

function dropRoom(room) {
    clearTimer(room);
    for (const res of room.listeners) { try { res.end(); } catch (e) { /* 이미 끊김 */ } }
    rooms.delete(room.code);
}

function touch(room) {
    room.touched = Date.now();
}

// 조용한 방을 주기적으로 치운다. 안 그러면 메모리에 쌓이기만 한다.
setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
        if (now - room.touched > IDLE_MS) dropRoom(room);
    }
}, 60 * 1000).unref();

/* -----------------------------------------------------------
   실시간 전달 (SSE)
----------------------------------------------------------- */

/**
 * 내려보낼 방 상태.
 * 단어 목록은 넣지 않는다. 방금 나온 한 낱말만, 그것도 잠깐만 넣는다.
 */
export function viewOf(room, forPlayerId) {
    const revealing = room.status === 'reveal' && room.lastAdded;
    const aliveCount = room.players.filter(p => p.alive).length;

    return {
        code: room.code,
        status: room.status,
        lang: room.lang,
        topic: room.topic,
        seconds: room.seconds,
        hostId: room.hostId,
        youAreHost: room.hostId === forPlayerId,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            isYou: p.id === forPlayerId,
        })),
        // 공개 중에도 다음 차례가 누구인지 보여준다. 미리 마음의 준비를 하도록.
        turnPlayerId: (room.status === 'playing' || room.status === 'reveal')
            ? currentPlayer(room)?.id || null : null,
        wordCount: room.entries.length,
        cursor: room.cursor,
        deadline: room.deadline || 0,
        lastAdded: revealing ? { word: room.lastAdded.word, name: room.lastAdded.name } : null,
        revealDeadline: revealing ? room.revealDeadline : 0,
        revealAcked: revealing ? room.revealAck.has(forPlayerId) : false,
        revealAckCount: revealing ? room.revealAck.size : 0,
        aliveCount,
        lastEvent: room.lastEvent,
        winnerId: room.winnerId,
        // 판이 끝난 뒤에야 전체를 공개한다
        words: room.status === 'done'
            ? room.entries.map(e => ({
                word: e.word,
                by: room.players.find(p => p.id === e.by)?.name || '?',
            }))
            : null,
    };
}

export function addListener(room, playerId, res) {
    const entry = { playerId, res };
    room.listeners.add(entry);
    send(entry, viewOf(room, playerId));
    return () => room.listeners.delete(entry);
}

function broadcast(room) {
    for (const entry of room.listeners) send(entry, viewOf(room, entry.playerId));
}

function send(entry, data) {
    try {
        entry.res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) {
        // 끊긴 연결은 다음 정리 때 빠진다
    }
}

/** 새 낱말 공개가 끝나는 시점에 화면을 한 번 더 갱신해 준다 */
export function scheduleRevealEnd(room) {
    if (!room.lastAdded) return;
    const wait = Math.max(0, room.lastAdded.until - Date.now()) + 50;
    setTimeout(() => {
        if (rooms.get(room.code) === room) broadcast(room);
    }, wait).unref?.();
}

function fail(message, status, extra) {
    const err = new Error(message);
    err.status = status || 400;
    Object.assign(err, extra || {});
    return err;
}

export { MAX_PLAYERS };
