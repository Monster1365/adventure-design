// Vercel 서버리스 함수 진입점. vercel.json 의 rewrites 로 /api/* 요청이 모두 여기로 온다.
// 데이터는 DATABASE_URL 의 외부 PostgreSQL 에 저장되므로 인스턴스가 바뀌어도 유지된다.
const { open } = require("../server/db");
const { createApp } = require("../server/app");

module.exports = createApp(open());
