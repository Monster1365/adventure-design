# 학식먹자

학생식당 사전 주문 서비스. 기존 정적 프로토타입(`public/`)에 Express API 와 PostgreSQL 을 연결했다.

## 기술 스택 · 의존성

| 구분 | 이름 | 버전 | 용도 |
|---|---|---|---|
| 런타임 | Node.js | 22.x | 서버 실행 (`package.json` 의 `engines`) |
| 의존성 | [express](https://www.npmjs.com/package/express) | 5.3.0 | HTTP 서버 · API 라우팅 · 정적 파일 서빙 |
| 의존성 | [pg](https://www.npmjs.com/package/pg) | 8.16.3 | PostgreSQL 클라이언트 (연결 풀 · 트랜잭션) |
| 개발 의존성 | [embedded-postgres](https://www.npmjs.com/package/embedded-postgres) | 17.10.0-beta.17 | 테스트용 임시 PostgreSQL (`npm test`) |
| 데이터베이스 | PostgreSQL | — | 외부 DB (`DATABASE_URL`), 테스트는 PostgreSQL 17 |
| 테스트 | node:test | Node.js 내장 | API 통합 테스트 |
| 프론트엔드 | HTML · CSS · JavaScript | — | 프레임워크·빌드 없음, 웹폰트(Black Han Sans, Gothic A1)만 Google Fonts 사용 |
| 배포 | Vercel | — | `public/` 정적 파일 + `api/index.js` 서버리스 함수 |

버전은 `package-lock.json` 에 설치된 버전 기준이다. 외부 로그인은 라이브러리 없이 각 공급자의 OAuth 2.0 API 를 직접 호출한다.

![학식먹자 시스템 아키텍처](docs/architecture.png)

## 실행

```bash
npm install
# .env 에 DATABASE_URL(PostgreSQL 연결 문자열)과 사용할 로그인 공급자의 키 입력
npm start              # http://localhost:3000
npm test               # API 통합 테스트 (임시 PostgreSQL 을 자동으로 띄움)
```

Node.js 22. 서버가 처음 DB 에 연결될 때 `schema.sql` 로 테이블을 만들고, 메뉴가 비어 있으면 기존 프로토타입의 메뉴를 초기 데이터로 넣는다.
여러 서버가 동시에 떠도 초기화는 PostgreSQL advisory lock 으로 한 번에 하나만 실행된다.

`npm test` 는 `embedded-postgres` 로 임시 PostgreSQL 을 띄워 실행하고 끝나면 지운다.
이미 있는 빈 DB 로 돌리려면 `TEST_DATABASE_URL` 을 지정한다(테스트가 데이터를 쓰므로 운영 DB 는 쓰지 말 것).

## 구조

```
public/            기존 프론트엔드 (index.html, script.js, style.css)
server/
  schema.sql       테이블 · 인덱스 · 트리거
  db.js            PostgreSQL 연결 풀, 스키마 적용, 초기 메뉴
  store.js         데이터 접근 계층 (SQL, 트랜잭션, 검증)
  auth.js          외부 로그인(OAuth 2.0) 연동, 세션
  food-info.js     메뉴별 알레르기 · 코너별 원산지 (원본 데이터, 시작 시 DB 동기화)
  app.js           HTTP 라우팅
test/api.test.js   통합 테스트
```

## 로그인

로그인 화면의 카카오톡·네이버·구글 버튼은 각 공급자의 공식 OAuth 2.0 인가 코드 방식으로 연결된다.
`.env` 에 `<PROVIDER>_CLIENT_ID` (+ `_CLIENT_SECRET`) 를 넣은 공급자만 활성화되고, 나머지 버튼은 흐리게 표시된다.
각 개발자 콘솔에 등록할 Redirect URI: `${BASE_URL}/api/auth/<kakao|naver|google>/callback`

- 키와 공급자 액세스 토큰은 서버에서만 사용하고 저장하거나 프론트엔드로 보내지 않는다.
- 로그인에 성공하면 무작위 세션 토큰을 `HttpOnly` 쿠키(30일)로 발급하고, DB `sessions` 테이블에는 토큰의 SHA-256 해시만 저장한다.
- 로그아웃하면 DB 의 세션을 지우므로 같은 쿠키로도 다시 접근할 수 없다.

## 배포 (Vercel)

`api/index.js` 가 Express 앱을 서버리스 함수로 내보내고, `vercel.json` 이 `/api/*` 요청을 그쪽으로 보낸다. 화면은 `public/` 이 정적으로 서빙된다.

- 환경변수: `DATABASE_URL`, `BASE_URL=https://<배포 도메인>`, `COOKIE_SECURE=1`, 사용할 공급자의 `*_CLIENT_ID` / `*_CLIENT_SECRET`
- `DATABASE_URL` 은 서버리스용 **풀링(pooled) 연결 문자열**을 권장한다 (Neon: 호스트에 `-pooler`, Supabase: Transaction pooler). 인스턴스당 연결은 최대 3개.
- 각 공급자 콘솔에 `https://<배포 도메인>/api/auth/<provider>/callback` 을 Redirect URI 로 등록
- 환경변수를 바꾸면 다시 배포해야 적용된다

## 식품 정보 (알레르기 · 원산지)

`server/food-info.js` 가 원본이다. 서버를 시작할 때마다 이 파일 내용으로 `menu_allergens`, `category_origins` 테이블을 다시 맞춘다.

- **원산지**: 코너(카테고리)별, 식당 제공 정보. 스낵·한식·일식은 같은 목록을 쓴다.
- **알레르기**: 메뉴별. 메뉴 이름으로 추정한 **초안**이며 `ALLERGENS_VERIFIED = false` 인 동안 화면에 "확인 전" 안내가 표시된다.
  식당의 실제 정보로 채운 뒤 `true` 로 바꾸고 서버를 재시작하면 된다.

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/api/me` | | 현재 사용자 (비로그인이면 `null`) |
| GET | `/api/menus?sort=` | | `default` `price_asc` `price_desc` `rating_desc` `rating_asc` |
| GET | `/api/menus/:id/reviews` | | 메뉴, 리뷰(최신순), 내 작성 가능 여부 |
| GET | `/api/stats/menu-orders` | | 오늘(한국 시간) 전체 · 카테고리별 · 메뉴별 주문 건수와 수량 (취소 제외, 자정 초기화) |
| GET | `/api/food-info` | | 메뉴별 알레르기 · 코너별 원산지 |
| GET/POST | `/api/orders` | ✔ | 내 주문 목록 / 주문 생성 |
| POST | `/api/orders/:id/reorder` | ✔ | `{cart}` 에 과거 주문을 합친 장바구니 반환 |
| POST | `/api/menus/:id/reviews` | ✔ | 리뷰 작성 (주문 이력 필요, 메뉴당 1개) |
| PUT/DELETE | `/api/reviews/:id` | ✔ | 내 리뷰 수정 / 삭제 |
| GET | `/api/me/reviews` | ✔ | 내가 쓴 리뷰 |
| GET | `/api/me/reviewable` | ✔ | 리뷰 쓰기 화면: 내가 주문했던 메뉴와 작성 여부 |
| GET | `/api/favorites` | ✔ | 즐겨찾기 |
| PUT/DELETE | `/api/favorites/:menuId` | ✔ | 즐겨찾기 추가 / 해제 |
