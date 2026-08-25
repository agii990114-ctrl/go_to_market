// 목업 모드로 서버를 켠다 (윈도우/맥 어디서나 `npm run mock` 한 줄).
// 실제 AI 를 부르지 않으므로 API 키가 없어도 화면 흐름을 다 볼 수 있다.
process.env.MOCK = 'true';
await import('./index.js');
