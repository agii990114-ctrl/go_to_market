/**
 * 게임에 참여하는 네 개의 AI 역할.
 *
 *   심판 (judge)     : 양쪽이 낸 단어를 공식 판정한다. 여기서 탈락하면 그 사람이 진다.
 *   플레이어 (generate): AI 차례에 새 단어를 하나 만들어낸다.
 *   검수 (inspect)   : 플레이어 AI 가 만든 단어를 채택 전에 미리 걸러낸다.
 *   진행자 (topics)  : 주제를 추천한다.
 *
 * 검수와 심판은 "같은 기준(RUBRIC)"을 쓴다. 기준이 다르면 AI 만 억울하게 불리해진다.
 * 한때 검수에만 "탈락시킬 이유를 먼저 찾아라"는 적대적 프레이밍을 넣어 봤는데,
 * "애매하면 통과" 원칙과 충돌해서 '향신료' 같은 멀쩡한 단어까지 떨어뜨렸다.
 * 두 역할이 같은 모델로 해석되면 답이 똑같아지는데, 그 중복은 프롬프트를 비트는 대신
 * game.js 에서 심판 호출을 건너뛰는 것으로 해결한다.
 */
import { askJson, modelFor } from './llm.js';
import { cachedVerdict } from './verdict-cache.js';

/* 판정 기준 — 심판과 검수가 글자 그대로 공유한다.
 *
 * 한때 "실제로 쓰는 낱말인가" 를 엄격히 보라는 긴 항목이 여기 있었다.
 * 지금은 뺐다. AI 단어는 dictionary.js 가 코드로 먼저 거르고, 사람 단어에는
 * 일부러 사전 검사를 걸지 않기 때문에 두 역할 모두에게 쓸모가 없었다.
 * 게다가 기준 중 가장 길고 "탈락" 이 많이 나오는 부분이라 모델이 그쪽으로 기울어,
 * 냉장고 주제에 "고기", "우유" 까지 탈락시켰다. (사유: "보관되지만 관련성이 낮다")
 */
const RUBRIC = `[판정 기준]
1. 기본은 통과다. 이어지는 지점이 아예 없을 때만 탈락시킨다.
2. "<주제>에 가면 <단어>도 있고~" 라고 말했을 때 한국어 화자가 고개를 끄덕이면 통과다.
3. 주제 안에 있는 것, 주제에 보관하거나 담는 것, 주제에서 파는 것,
   주제에서 하는 일, 거기서 나는 소리·냄새, 거기 있는 사람 — 전부 통과다.
4. 비유나 문화적 연상도 억지스럽지 않으면 통과다.
5. 애매하면 통과시킨다. 억울한 탈락이 느슨한 통과보다 나쁘다.
6. **주제 안에 실제로 있을 수 있는 것은 무조건 통과다.**
   반갑지 않은 것이라도 통과다 — 잡초, 벌레, 쓰레기, 먼지, 곰팡이, 소음.
   "있기는 하지만 좋지 않다" 는 탈락 사유가 되지 못한다.
7. 판정은 "그 장소에서 **흔히** 볼 수 있는가" 로 한다.
   "있을 수도 있다", "팔릴 수도 있다" 는 근거가 되지 못한다.
   그 말로는 무엇이든 통과시킬 수 있기 때문이다.
   반갑지 않은 것이라도 흔히 있으면 통과다(쥐, 잡초, 먼지).
   흔치 않으면, 아무리 "가능은 하다" 해도 탈락이다.
8. 탈락시키는 경우는 딱 둘뿐이다.
   (가) 이어지는 지점이 아예 없다.  예: 냉장고 / 화산, 시장 / 미적분
   (나) 계절이나 환경이 반대여서 그 자리에 놓이지 않는다.
        예: 여름 / 눈사람·패딩 (겨울 것이다), 냉장고 / 화로 (데우는 것이다)
   이 둘이 아니면 통과다.
9. 자판을 아무렇게나 친 것으로 보이면 탈락이다.
10. 오직 "주제 적합성"만 본다. 이미 나온 단어인지(중복)는 절대 보지 않는다. 중복은 게임 코드가 따로 처리한다.
11. 맞춤법이 조금 틀려도 무슨 말인지 알아볼 수 있으면 통과다.

[판정 예시]
주제 "냉장고" / "고기"    → 통과. 냉장고에 고기를 넣어 두는 건 흔한 일이다.
주제 "냉장고" / "우유"    → 통과. 우유는 냉장 보관하는 대표적인 것이다.
주제 "냉장고" / "성에"    → 통과. 냉동칸에 끼는 성에가 떠오른다.
주제 "냉장고" / "화산"    → 탈락. 이어지는 지점이 아예 없다.
주제 "시장"   / "흥정"    → 통과. 시장 하면 바로 떠오르는 장면이다.
주제 "시장"   / "지갑"    → 통과. 시장에 갈 때 챙겨 가는 것이다.
주제 "시장"   / "미적분"  → 탈락. 시장과 이어지는 지점이 없다.
주제 "학교"   / "첫사랑"  → 통과. 학교에서 흔히 떠올리는 기억이다.
주제 "학교"   / "asdfgh" → 탈락. 자판을 아무렇게나 친 것이다.
주제 "여름"   / "빙수"    → 통과. 여름에 먹는 것이다.
주제 "여름"   / "눈사람"  → 탈락. 겨울 것이라 여름과 정반대다.
주제 "겨울"   / "장갑"    → 통과. 겨울에 끼는 것이다.
주제 "과일밭" / "잡초"    → 통과. 반갑지 않아도 밭에 실제로 난다.
주제 "과일밭" / "풀"      → 통과. 밭에 나는 것이다.
주제 "과일밭" / "모래"    → 통과. 밭 흙에 섞여 있을 수 있다.
주제 "시장"   / "고양이"  → 통과. 시장 길고양이는 흔한 풍경이다.
주제 "시장"   / "쥐"      → 통과. 반갑지 않아도 흔히 있다.
주제 "시장"   / "사자"    → 탈락. "팔릴 수도 있다" 는 말뿐이고 실제로는 없다.
주제 "시장"   / "고래"    → 탈락. 흔히 볼 수 있는 것이 아니다.

"보관한다", "거기서 쓴다", "거기서 판다", "거기 난다" 만으로도 충분한 이유다.
"직접적인 관련성이 부족하다" 는 판정은 위의 "화산", "미적분" 같은 경우에만 쓴다.
"방해가 된다", "좋지 않다", "어울리지 않는다" 는 탈락 사유가 아니다.

특히 "있을 수 있지만 관련성이 부족하다" 는 말은 모순이다. 있을 수 있으면 통과다.
사유를 쓰다가 "존재할 수 있지만", "볼 수는 있지만" 이라고 적게 되면
그 순간 답은 통과다.

[출력 규칙]
- reason 은 40자 이내의 한 문장으로 짧게 쓴다.
- 같은 말을 두 번 쓰지 않는다. 설명을 늘이지 않는다.`;

/*
 * 영어판 판정 기준.
 * 한국어판에서 얻은 것들을 그대로 옮겼다 — 기본은 통과, 반갑지 않은 것도 통과,
 * 탈락은 "이어지는 지점이 없다" 와 "계절·환경이 반대다" 둘뿐,
 * "있기는 한데 관련성이 부족하다" 같은 자기모순 사유 금지.
 */
const RUBRIC_EN = `[How to judge]

THE ONE TEST: is this **commonly** at that place?
Not "could it be", not "might it be sold there" — is it commonly there?
"It might be there" would let absolutely anything pass, so it never counts.
Say the sentence out loud: "At the <topic> there is <word>."
If that describes an ordinary day at that place, it passes. If it describes
something you would be astonished to see, it fails.

1. Judge by that test. Be generous inside it — most everyday things pass.
2. If a Korean speaker would nod at "At the <topic> there is <word>", it passes.
3. Anything inside the place, stored there, sold there, done there,
   heard or smelled there, or any person who is there — all pass.
4. Figurative or cultural associations pass if they are not far-fetched.
5. **Anything that can actually be there passes, even if unwelcome** —
   weeds, dust, noise, mould, rubbish. "It is there but undesirable" is not a reason to fail.
6. Unwelcome things pass if they are commonly there — rats, weeds, dust, mould.
   Uncommon things fail, however possible they are.
7. There are only two reasons to fail.
   (a) There is no connection at all.   e.g. fridge / volcano, market / calculus
   (b) The season or environment is the opposite, so it would not be there.
       e.g. summer / snowman (that is winter), fridge / furnace (that heats)
   Anything else passes.
8. Fail if it looks like random keyboard mashing.
9. Judge topic fit only. Never consider whether the word was already used —
   the game code handles duplicates separately.
10. Minor spelling slips pass if the word is recognisable.

[Examples]
topic "fridge"    / "meat"     -> pass. People keep meat in a fridge.
topic "fridge"    / "milk"     -> pass. Milk is the classic thing to refrigerate.
topic "fridge"    / "volcano"  -> fail. There is no connection at all.
topic "market"    / "haggling" -> pass. It is the scene a market brings to mind.
topic "market"    / "wallet"   -> pass. You take one with you to the market.
topic "market"    / "calculus" -> fail. Nothing connects it to a market.
topic "orchard"   / "weeds"    -> pass. Unwelcome, but they really grow there.
topic "bathhouse" / "steam"    -> pass. Steam fills a bathhouse.
topic "summer"    / "snowman"  -> fail. That belongs to winter, the opposite season.
topic "library"   / "asdfgh"   -> fail. That is keyboard mashing.
topic "market"    / "cat"      -> pass. Stray cats are a common market sight.
topic "market"    / "rat"      -> pass. Unwelcome, but commonly there.
topic "market"    / "lion"     -> fail. "Might be sold" is talk; lions are not there.
topic "market"    / "whale"    -> fail. Not something you commonly see at a market.

"It is stored there", "it is used there", "it is sold there", "it grows there"
are each reason enough on their own.
"Not directly related" belongs only to cases like "volcano" and "calculus".
"It gets in the way", "it is undesirable", "it does not belong" are NOT reasons to fail.
But "it could be there", "it might be sold there" are NOT reasons to pass either.
Ask whether it is commonly there, not whether it is possible.
Above all, "it can be there but is not directly related" is a contradiction.
If it can be there, it passes. The moment you find yourself writing
"it could be there, but", the answer is pass.

[Output]
- reason must be one short English sentence, under 12 words.
- **Never write "might", "could", "sometimes", "occasionally", "possibly" in reason.**
  If those are the only words that fit, the answer is fail, not pass.
  A passing reason states a plain fact: "Fish are sold at markets."
  Not "Fish might be sold at markets."`;

/* 영어판 장소 기준 */
const PLACE_RULE_EN = `[What can be a topic]
A **space that has things inside it**, so that "At the <topic> there is ~" sounds natural.

There is one test. Put "go to the" in front of it and say it aloud.
  "go to the market"  -> sounds right. Pass.
  "go to the fruit"   -> does not. Fail.
  "go to the animal"  -> does not. Fail.

**The given word itself must be a space.**
Do not think of a place related to the word and pass it. This is the most common mistake.
  Seeing "fruit", do not think of a fruit shop. A fruit shop is a space; fruit is not.
  Seeing "animal", do not think of a zoo. A zoo is a space; an animal is not.
  Seeing "clothes", do not think of a wardrobe.
Judge the word exactly as given. Never substitute a related place for it.

Good: market, zoo, school, hospital, library, bathhouse, playground, bakery,
      butcher, sea, mountain, kitchen, classroom, fridge, drawer, backpack, subway
      **orchard**, wardrobe, aquarium — a kind-of-thing may appear in the name;
      what matters is that the thing named is a space. "go to the orchard" sounds right.
Bad:  fruit, animal, food, clothes, furniture (a kind of thing, not a space)
      summer, winter (a time, not a space)
      game, love, memory (an idea or a feeling)
      red, round (a quality)
      Beethoven, Newton (a person)

There must be things that can be inside it.
Times, feelings, ideas and kinds-of-thing do not count.`;

/* 영어판 생성 예시 */
const FEW_SHOT_EN = `[Good and bad answers]

topic "market", already used: fish
  good: haggling, anchovy, scale, basket, cart, vendor
  bad:  fishmarket (contains "fish"), marketnoise (not a real word), market (the topic itself)

topic "fridge", already used: kimchi
  good: egg, milk, leftovers, frost, ice
  bad:  kimchibox (contains "kimchi"), fridgedoor (contains the topic), coldshelf (not a real word)

topic "zoo", already used: elephant
  good: keeper, cage, feed, monkey, ticket
  bad:  elephanttrunk, zoopath, lioncage (not real words)

The point: only words a dictionary would list. Never glue two words together.`;

/* 영어 생성은 한글 뜻을 함께 받는다 — 영단어 공부용으로 쓰기 위해서다 */
const WORD_LIST_SCHEMA_EN = {
    type: 'object',
    properties: {
        words: {
            type: 'array',
            description: 'English words that fit the place, each with a short Korean meaning',
            minItems: 5,
            maxItems: 30,
            items: {
                type: 'object',
                properties: {
                    word: { type: 'string', maxLength: 16, description: 'lowercase English word' },
                    gloss: { type: 'string', maxLength: 14, description: 'Korean meaning, 2-6 characters' },
                },
                required: ['word', 'gloss'],
                additionalProperties: false,
            },
        },
    },
    required: ['words'],
    additionalProperties: false,
};

/*
 * valid 를 먼저 쓰게 둔다.
 *
 * reason 을 앞에 두면 이유를 먼저 쓰고 판정하니 더 나을 것 같았는데, 재보니
 * 반대였다(13/16 → 12/16). 모델이 통과를 정당화하는 이유를 먼저 지어 놓고
 * 거기에 판정을 맞춘다. valid 가 앞에 있으면 그럴 여지가 줄어든다.
 */
const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        valid: { type: 'boolean', description: '주제에 맞으면 true' },
        // 작은 모델은 이 칸에서 같은 문장을 무한 반복하다 토큰을 다 써 버린다.
        // 스키마와 프롬프트 양쪽에서 길이를 묶어 둔다.
        reason: { type: 'string', maxLength: 60, description: '40자 이내의 한 문장' },
    },
    required: ['valid', 'reason'],
    additionalProperties: false,
};

const WORD_SCHEMA = {
    type: 'object',
    properties: {
        // maxLength 가 핵심이다. 이게 없으면 모델이 이 칸에 설명을 써넣는다.
        // 실제로 "여기서는 좀 더 적절한 시장과 연관된 단어로 변경하겠습니다" 가 나왔다.
        // 길이를 막으면 문법 수준에서 아예 불가능해져 재시도가 크게 준다.
        word: {
            type: 'string',
            maxLength: 8,
            description: '주제에 맞는 새 단어 하나 (2~8글자). 포기할 때는 빈 문자열',
        },
        exhausted: { type: 'boolean', description: '더 이상 낼 단어가 정말 없을 때만 true' },
    },
    required: ['word', 'exhausted'],
    additionalProperties: false,
};

// 중첩 객체 배열은 7.8B 급 모델에게 버겁다. 빈 배열이나 "_OLD FAMILY TREASURE_"
// 같은 쓰레기를 뱉는다. 문자열 배열로 평평하게 만들면 안정적으로 나온다.
// 단어를 한 번에 여러 개 받는다.
// 하나씩 "떠올려" 달라고 하면 모델이 없는 말을 지어내지만,
// 여러 개를 "나열" 하게 하면 아는 낱말을 꺼내 놓는다. 실재어 판별은 코드가 한다.
// (bench/gen-strategy.js 측정 : 쓸 만한 단어 하나당 2.6초 → 0.6초)
const WORD_LIST_SCHEMA = {
    type: 'object',
    properties: {
        words: {
            type: 'array',
            description: '주제에 어울리는 서로 다른 낱말들',
            // minItems 가 없으면 가끔 빈 배열을 돌려준다 (주제 추천에서도 같은 증상이 있었다).
            // 문법에 최소 개수를 박아 두면 그 경로 자체가 막힌다.
            minItems: 5,
            maxItems: 30,
            items: { type: 'string', maxLength: 8 },
        },
    },
    required: ['words'],
    additionalProperties: false,
};

const PLACE_SCHEMA = {
    type: 'object',
    properties: {
        isPlace: { type: 'boolean', description: '안에 무언가가 들어 있는 공간이면 true' },
        reason: { type: 'string', maxLength: 60, description: '40자 이내의 한국어 한 문장' },
    },
    required: ['isPlace', 'reason'],
    additionalProperties: false,
};

const TOPICS_SCHEMA = {
    type: 'object',
    properties: {
        topics: {
            type: 'array',
            description: '주제 이름 5개. 각각 2~10글자의 한국어',
            minItems: 5,
            maxItems: 5,
            items: { type: 'string' },
        },
    },
    required: ['topics'],
    additionalProperties: false,
};

/**
 * 판정 사유를 화면에 그대로 띄우기 전에 다듬는다.
 * 모델이 "**냉장고에는 고기를 보관합니다**" 처럼 강조 표시를 붙여 보내는데,
 * 게임 오버 화면에 별표가 그대로 찍힌다.
 */
function tidyVerdict(verdict) {
    const reason = String(verdict?.reason ?? '')
        .replace(/[*_`~]/g, '')
        // 모델이 프롬프트의 <주제> 표기를 흉내 내 꺾쇠를 흘린다 ("주제> 냉장고 안에서…")
        .replace(/[<>]/g, '')
        .replace(/^[(\[]+|[)\]]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { valid: Boolean(verdict?.valid), reason };
}

/* -----------------------------------------------------------
   심판 : 공식 판정
----------------------------------------------------------- */
export function judge(topic, word, lang = 'ko') {
    return cachedVerdict(
        { role: 'judge', model: modelFor('judge'), topic: lang + ':' + topic, word },
        () => askJsonJudge(topic, word, lang),
    );
}

function askJsonJudge(topic, word, lang) {
    if (lang === 'en') {
        return askJson({
            role: 'judge',
            maxTokens: 400,
            system: `You are the judge of the Korean word game "When I go to the market".
Decide only whether the submitted word fits the topic.
Look for a reason to pass first. Fail only when you cannot find one.
Be generous but consistent — the same word must always get the same verdict.

${RUBRIC_EN}`,
            user: `Topic: "${topic}"\nnSubmitted word: "${word}"\nn\nnDoes this word fit the topic?`,
            schema: VERDICT_SCHEMA,
        }).then(tidyVerdict);
    }
    return askJson({
        role: 'judge',
        maxTokens: 400,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 심판이다.
플레이어가 낸 단어가 주제에 맞는지만 판정한다.
먼저 통과시킬 이유를 찾아본다. 찾지 못했을 때만 탈락시킨다.
판정은 관대하되 일관되어야 한다. 같은 단어에는 언제나 같은 판정을 내려야 한다.

${RUBRIC}`,
        user: `주제: "${topic}"\n제출된 단어: "${word}"\n\n이 단어는 주제에 맞습니까?`,
        schema: VERDICT_SCHEMA,
    }).then(tidyVerdict);
}

/* -----------------------------------------------------------
   검수 : 플레이어 AI 의 단어를 채택 전에 거른다
   심판과 완전히 별개의 호출이고, 그 단어를 왜 골랐는지는 알려주지 않는다.
----------------------------------------------------------- */
export function inspect(topic, word, lang = 'ko') {
    return cachedVerdict(
        { role: 'inspect', model: modelFor('inspect'), topic: lang + ':' + topic, word },
        () => askJsonInspect(topic, word, lang),
    );
}

function askJsonInspect(topic, word, lang) {
    if (lang === 'en') {
        return askJson({
            role: 'inspect',
            maxTokens: 400,
            system: `You are the checker of the Korean word game "When I go to the market".
You only confirm, independently, whether a word fits the topic.
You do not know who submitted it or why, and you do not need to.

${RUBRIC_EN}`,
            user: `Topic: "${topic}"\nnWord to check: "${word}"\nn\nnDoes this word fit the topic?`,
            schema: VERDICT_SCHEMA,
        }).then(tidyVerdict);
    }
    return askJson({
        role: 'inspect',
        maxTokens: 400,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 검수 담당이다.
어떤 단어가 주제에 맞는지 아닌지만 독립적으로 확인한다.
누가 낸 단어인지, 왜 골랐는지는 알 수 없고 알 필요도 없다.

${RUBRIC}`,
        user: `주제: "${topic}"\n검수할 단어: "${word}"\n\n이 단어는 주제에 맞습니까?`,
        schema: VERDICT_SCHEMA,
    }).then(tidyVerdict);
}

/* 좋은 답이 어떻게 생겼는지 보여 준다. 규칙 문장만으로는 잘 안 먹힌다.
   (측정 : 이걸 넣으면 12번 중 쓸 만한 단어가 7개 → 10개) */
const FEW_SHOT = `[좋은 답과 나쁜 답의 예]

주제 "시장", 이미 나온 단어: 고등어
  좋음: 흥정, 멸치, 저울, 함지박, 리어카, 엿장수
  나쁨: 고등어살(고등어를 품음), 흥정소리(사전에 없음), 시장(주제 그 자체)

주제 "냉장고", 이미 나온 단어: 김치
  좋음: 계란, 우유, 반찬, 성에, 얼음
  나쁨: 김치통(김치를 품음), 냉장고문(주제를 품음), 반찬칸(사전에 없음)

주제 "동물원", 이미 나온 단어: 코끼리
  좋음: 사육사, 우리, 먹이, 원숭이, 매표소
  나쁨: 코끼리코, 동물원길, 사자우리(사전에 없음)

핵심: 국어사전에 실려 있는 낱말만. 낱말을 붙여 지어내지 말 것.`;

/* -----------------------------------------------------------
   플레이어 AI : 새 단어를 한 번에 여러 개 생성
----------------------------------------------------------- */
export function generateWords(topic, usedWords, count = 20, lang = 'ko') {
    if (lang === 'en') return generateWordsEn(topic, usedWords, count);

    const usedBlock = usedWords.length ? usedWords.join(', ') : '(아직 없음)';

    return askJson({
        role: 'generate',
        maxTokens: 900,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 플레이어다.
주제에 어울리는 낱말을 여러 개 나열한다.

[규칙]
- 이미 나온 단어 목록에 있는 단어는 절대 쓰지 않는다.
- 주제 그 자체를 단어로 내지 않는다. 주제 안에서 볼 수 있는 것을 낸다.
- 사람이 듣고 바로 외울 수 있는, 2~5글자의 일상적인 한국어 명사를 고른다.
  "혼잡하다", "활짝" 처럼 움직씨·그림씨·어찌씨는 외우기 어려워서 안 된다.
- **국어사전에 실려 있는 낱말만 쓴다. 두 낱말을 붙여 새말을 만들지 않는다.**
- 서식 기호나 설명을 붙이지 않는다. 낱말만 적는다.
- 사물만 이어 가지 말고 사람, 행동, 소리, 냄새, 도구 쪽으로도 뻗는다.
- 뻔한 것부터 덜 뻔한 것까지 골고루 섞는다.

${FEW_SHOT}`,
        user: `주제: "${topic}"\n이미 나온 단어: ${usedBlock}\n\n`
            + `서로 다른 낱말 ${count}개를 나열해주세요.`,
        schema: WORD_LIST_SCHEMA,
    });
}

/**
 * 영어 낱말을 한글 뜻과 함께 받는다.
 *
 * 뜻을 별도 호출로 번역하면 느려진다. 어차피 부르는 생성 호출에 칸을 하나 더 얹는 게 공짜다.
 * (심판 호출에도 얹어 봤지만 거기선 불안정했다 — calculus 의 뜻을 "시장" 이라고 답했다.
 *  판정에 집중하느라 단어 대신 주제를 번역해 버린다.)
 */
function generateWordsEn(topic, usedWords, count) {
    const usedBlock = usedWords.length ? usedWords.join(', ') : '(none yet)';

    return askJson({
        role: 'generate',
        maxTokens: 1400,
        system: `You are a player of the Korean word game "When I go to the market".
List English words that fit the place, each with a short Korean meaning.

[Rules]
- Never use a word from the already-used list. Avoid close synonyms of them too.
- Never use the topic itself. Name things found inside the place.
- Pick everyday English nouns a learner can memorise. One word, lowercase.
- **Only words an English dictionary would list. Never glue two words together.**
- No formatting, no quotes, no punctuation. Just the word.
- gloss: the Korean meaning, 2 to 6 Korean characters. No romanisation, no English.
- Spread out — objects, people, actions, sounds, smells, tools.
- Mix obvious ones with less obvious ones.

${FEW_SHOT_EN}`,
        user: `Topic: "${topic}"\nAlready used: ${usedBlock}\n\n`
            + `List ${count} different words with their Korean meanings.`,
        schema: WORD_LIST_SCHEMA_EN,
    });
}

/*
 * 장소 기준 — 주제 추천과 주제 검증이 글자 그대로 공유한다.
 * 추천이 만들어 낸 주제를 검증이 되돌려 보내면 안 되므로 기준이 같아야 한다.
 */
const PLACE_RULE = `[주제가 될 수 있는 것]
"<주제>에 가면 ~도 있고" 라고 말했을 때 자연스러운, **안에 무언가가 들어 있는 공간**이다.

판정하는 법은 하나다. 주제 뒤에 "에 가면" 을 붙여 소리 내 보라.
  "시장에 가면"   → 말이 된다. 통과.
  "과일에 가면"   → 말이 안 된다. 탈락.
  "동물에 가면"   → 말이 안 된다. 탈락.

**주제로 주어진 그 낱말 자체가 공간이어야 한다.**
그 낱말과 관련된 장소를 떠올려 통과시키면 안 된다. 이게 가장 흔한 실수다.
  "과일" 을 보고 과일 가게를 떠올리면 안 된다. 과일 가게는 공간이지만 과일은 아니다.
  "동물" 을 보고 동물원을 떠올리면 안 된다. 동물원은 공간이지만 동물은 아니다.
  "옷" 을 보고 옷장을 떠올리면 안 된다.
주어진 낱말을 다른 말로 바꿔 읽지 말고, 그 낱말 그대로 판정하라.

통과: 시장, 동물원, 학교, 병원, 도서관, 목욕탕, 놀이터, 편의점, 정육점,
      바다, 산, 부엌, 교실, 냉장고, 서랍, 가방, 할머니 댁, 지하철
      **과수원**, 꽃밭, 옷장 — 갈래 이름이 앞에 붙어 있어도 뒤가 공간이면 통과다.
      "과수원에 가면", "옷장에 가면" 은 말이 된다.
탈락: 과일·동물·음식·옷·가구 (사물의 갈래이지 공간이 아니다)
      여름·겨울 (때이지 공간이 아니다)
      게임·사랑·추억 (개념이나 감정이지 공간이 아니다)
      빨강·둥근 것 (성질이다)
      김연아·아이유 (사람이다)
      시장과일·냉장고채소 (지어낸 말이다)

담을 수 있는 물건이 안에 있어야 한다. 시간·감정·개념·사물의 갈래는 안 된다.`;

/* -----------------------------------------------------------
   주제 검증 : 사람이 직접 쓴 주제가 장소인지 본다
----------------------------------------------------------- */
export function validateTopic(topic, lang = 'ko') {
    // 같은 주제를 다시 고를 때 2~3초를 또 기다릴 이유가 없다.
    // 판정과 같은 캐시를 쓰되 역할 이름으로 키를 갈라 둔다.
    return cachedVerdict(
        { role: 'topic-check', model: modelFor('judge'), topic: lang + ':' + topic, word: '' },
        () => askTopicIsPlace(topic, lang),
    ).then(v => ({ isPlace: v.valid, reason: v.reason }));
}

function askTopicIsPlace(topic, lang) {
    if (lang === 'en') {
        return askJson({
            role: 'judge',
            maxTokens: 300,
            system: `You are the host of the Korean word game "When I go to the market".
Decide only whether the topic can be used for this game.

${PLACE_RULE_EN}

When in doubt, allow it. But times, feelings, ideas and people are clearly not allowed.

[Output] reason must be one short Korean sentence, under 30 characters.
If you reject it, say briefly why in Korean.`,
            user: `Topic candidate: "${topic}"\nn\nnCan this be used as a place topic?`,
            schema: PLACE_SCHEMA,
        }).then(v => ({
            valid: Boolean(v?.isPlace),
            reason: String(v?.reason ?? '').replace(/[*_`~<>]/g, '').trim(),
        }));
    }
    return askJson({
        role: 'judge',
        maxTokens: 300,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 진행자다.
사람이 낸 주제가 이 게임에 쓸 수 있는 것인지만 판정한다.

${PLACE_RULE}

애매하면 통과시킨다. 다만 때·감정·개념·사람은 분명히 탈락이다.

[출력 규칙] reason 은 40자 이내 한 문장. 탈락일 때는 왜 안 되는지 짧게 쓴다.`,
        user: `주제 후보: "${topic}"\nn\nn이 주제로 게임을 할 수 있습니까?`,
        schema: PLACE_SCHEMA,
    }).then(v => ({
        // 캐시가 다루는 모양({valid, reason})에 맞춰 둔다
        valid: Boolean(v?.isPlace),
        reason: String(v?.reason ?? '').replace(/[*_`~<>]/g, '').trim(),
    }));
}

/* -----------------------------------------------------------
   뜻 달기 : 사람이 직접 친 단어에는 뜻이 없다
----------------------------------------------------------- */
const GLOSS_SCHEMA = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    word: { type: 'string', maxLength: 20 },
                    gloss: { type: 'string', maxLength: 14 },
                },
                required: ['word', 'gloss'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
};

/**
 * 영어 낱말들의 한글 뜻을 한 번에 받는다.
 *
 * AI 가 낸 단어는 생성할 때 뜻을 함께 받지만, 사람이 직접 친 단어에는 뜻이 없다.
 * 단어장에 뜻 없는 칸이 생기면 학습용으로 쓸 수가 없다.
 * 낱말마다 부르면 느리니 한 번에 묶어서 받는다.
 */
export function glossWords(words) {
    if (!words.length) return Promise.resolve({ items: [] });

    return askJson({
        role: 'generate',
        maxTokens: 900,
        system: `You give the Korean meaning of English words.

[Rules]
- For each word, give its Korean meaning in 2 to 6 Korean characters.
- Korean only. No romanisation, no English, no brackets, no explanation.
- Keep the word exactly as given. Do not correct or change it.
- Give one entry for every word you are given, in the same order.`,
        user: `Give the Korean meaning of each word.\n\n${words.join('\n')}`,
        schema: GLOSS_SCHEMA,
    });
}

/* -----------------------------------------------------------
   주제 추천
----------------------------------------------------------- */
export function suggestTopics(lang = 'ko') {
    if (lang === 'en') {
        return askJson({
            role: 'topics',
            maxTokens: 800,
            system: `You are the host of the Korean word game "When I go to the market".
Suggest 5 places for the game.

${PLACE_RULE_EN}

[Rules]
- Pick places anyone knows, where at least 20 words come to mind easily.
- **Only words an English dictionary would list. Never invent compounds.**
- Mix one obvious place (market, zoo) with less obvious ones (bathhouse, drawer, attic).
- 2 to 16 letters, lowercase. No explanations, no punctuation.
- Suggest a different set each time.`,
            user: 'List 5 places only.',
            schema: TOPICS_SCHEMA,
        });
    }

    return askJson({
        role: 'topics',
        maxTokens: 800,
        system: `당신은 한국의 말놀이 '시장에 가면' 게임의 진행자다.
게임에 쓸 장소를 5개 추천한다.

${PLACE_RULE}

[규칙]
- 한국 사람이라면 누구나 아는 장소로 고른다. 단어가 20개 이상 나올 만한 곳이어야 한다.
- **국어사전에 실려 있는 낱말만 쓴다. 두 낱말을 붙여 새말을 만들지 않는다.**
  "시장과일", "냉장고채소", "할머니김치" 같은 조어는 절대 안 된다.
- '시장', '동물원' 같은 뻔한 곳 하나와, '목욕탕', '서랍', '할머니 댁' 처럼
  덜 뻔한 곳을 섞는다.
- 2~10글자의 한국어로 짧게 쓴다. 설명을 붙이지 않는다.
- 매번 다른 조합을 제안한다.`,
        user: '장소 5개만 나열해주세요.',
        schema: TOPICS_SCHEMA,
    });
}
