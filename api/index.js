// Vercel 서버리스 함수 진입점. vercel.json 의 rewrites 로 /api/* 요청이 모두 여기로 온다.
// 서버리스 환경은 /tmp 만 쓸 수 있어 DB 는 인스턴스가 새로 뜰 때마다 초기 메뉴로 다시 만들어진다
// (주문·리뷰·로그인 세션이 유지되지 않는 프로토타입용 구성).
const { open } = require("../server/db");
const { createApp } = require("../server/app");

module.exports = createApp(open());
