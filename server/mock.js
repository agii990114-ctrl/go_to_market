/**
 * API 키 없이 게임 흐름만 확인하고 싶을 때 쓰는 가짜 응답기.
 *
 *   MOCK=true npm start
 *
 * 실제 판정과는 아무 상관이 없다. 화면 전환, 재생성 루프, 승패 처리가
 * 제대로 도는지 눈으로 보기 위한 용도다.
 */

const POOL = [
    '사과', '고등어', '참기름', '떡볶이', '호떡', '양말', '수박', '국밥',
    '어묵', '뻥튀기', '순대', '옥수수', '고무장갑', '붕어빵', '흥정',
];

let cursor = 0;

export function mockAnswer(schema) {
    const keys = Object.keys(schema.properties || {});

    // 심판 / 검수
    if (keys.includes('valid')) {
        return { valid: true, reason: '(목업) 주제에 어울리는 단어로 보입니다.' };
    }

    // 주제 추천
    if (keys.includes('topics')) {
        return {
            topics: [
                { topic: '시장', hint: '먹거리와 흥정' },
                { topic: '냉장고 속', hint: '반찬통과 오래된 소스' },
                { topic: '동물원', hint: '동물과 사육사' },
                { topic: '여름', hint: '더위와 물놀이' },
                { topic: '할머니 댁', hint: '냄새와 물건들' },
            ],
        };
    }

    // 플레이어 AI
    if (keys.includes('word')) {
        if (cursor >= POOL.length) {
            cursor = 0;
            return { word: '', exhausted: true };   // 목업에서도 승리 화면을 볼 수 있게
        }
        return { word: POOL[cursor++], exhausted: false };
    }

    throw new Error('목업이 다룰 수 없는 스키마입니다.');
}
