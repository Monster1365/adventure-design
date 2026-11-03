const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// COUNT/SUM(bigint)과 numeric 을 문자열이 아닌 JS 숫자로 받는다 (값 범위가 작아 안전)
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, parseFloat);

// 기존 프론트엔드(script.js)에 하드코딩돼 있던 메뉴를 초기 데이터로 옮긴 것.
// stock 0 = 기존 "품절" 표시 메뉴
const SEED_STOCK = 30;
const SEED_MENUS = {
  한식: [
    ["비빔밥", 7000, "🍲"],
    ["묵은지김치찌개", 5800, "🥘"],
    ["부대햄플러스김치찌개", 6800, "🥘", 0],
    ["우삼겹된장찌개", 6600, "🥘"],
    ["별달소고기국밥", 7000, "🍲"],
    ["뚝배기닭갈비덮밥", 5800, "🍚", 0],
    ["치즈추가", 1500, "🧀"],
    ["구운계란 2개", 1500, "🥚"],
    ["공기밥", 1500, "🍚"],
  ],
  스낵: [
    ["버터김치별달알밥", 5600, "🍲"],
    ["버터김치치즈알밥", 6000, "🍲"],
    ["치즈 토핑", 1000, "🧀"],
    ["소불고기 토핑", 2000, "🥓"],
    ["떡갈비 토핑", 1000, "🍖"],
    ["감자고로케 토핑", 1000, "🥔"],
    ["날치알 토핑", 1000, "🧆"],
    ["구운계란 토핑", 500, "🥚"],
    ["컵버터감자칩", 2000, "🍟"],
  ],
  라면: [
    ["라면", 2500, "🍜"],
    ["떡만두라면", 3000, "🍜"],
    ["해장라면", 3000, "🍜"],
    ["치즈라면", 3000, "🍜"],
    ["부대라면", 4000, "🍜"],
    ["공기밥", 500, "🍚"],
  ],
  일식: [
    ["얼큰순두부우동국밥", 6300, "🍲"],
    ["매운부타동고기덮밥", 7500, "🍛"],
    ["고소한카레덮밥", 5800, "🍛"],
    ["부타동고기덮밥", 5800, "🍛"],
    ["치킨가라아게마요", 6500, "🍗"],
    ["세곱배기생우동", 6500, "🍜"],
    ["매운속풀이해장우동", 5300, "🍜"],
    ["가스오부시생우동", 5000, "🍜"],
    ["마제소바", 6000, "🍜"],
    ["1L치킨포케샐러드", 6800, "🥗"],
    ["½우동+주먹밥+가라아게4p", 7500, "🍱"],
    ["꼬치어묵2p+생우동", 6500, "🍢"],
    ["컵가라아게4p", 2000, "🥡"],
    ["½우동", 3500, "🍜"],
    ["주먹밥 2개", 1500, "🍙"],
  ],
  중식: [
    ["차돌온면", 6500, "🥢"],
    ["매운차돌온면", 6500, "🥢"],
    ["온국밥", 6500, "🍲"],
    ["비빔면", 5800, "🍝"],
    ["냉면", 5800, "🍝"],
    ["마라맛", 500, "🌶️"],
    ["공기밥", 500, "🍚"],
  ],
};

const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
const INIT_LOCK = 724100; // 여러 서버가 동시에 떠도 초기화는 한 번에 하나만

// 메뉴가 비어 있을 때만 초기 메뉴를 넣는다 (한 번의 INSERT)
async function seed(c) {
  const { rows } = await c.query("SELECT COUNT(*) AS n FROM menus");
  if (rows[0].n) return;
  const cols = [[], [], [], [], [], []];
  let i = 0;
  for (const [cat, items] of Object.entries(SEED_MENUS))
    for (const [name, price, image, stock = SEED_STOCK] of items)
      [cat, name, price, image, stock, i++].forEach((v, k) => cols[k].push(v));
  await c.query(
    `INSERT INTO menus (category, name, price, image, stock, sort_order)
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::int[])`,
    cols,
  );
}

// food-info.js 내용으로 식품 정보 테이블을 다시 맞춘다 (파일이 원본)
async function syncFoodInfo(c) {
  const { ALLERGENS, MENU_ALLERGENS, ORIGINS } = require("./food-info");
  await c.query("INSERT INTO allergens (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING", [
    ALLERGENS,
  ]);
  const ids = new Map((await c.query("SELECT name, id FROM allergens")).rows.map((r) => [r.name, r.id]));
  const menus = (await c.query("SELECT id, category, name FROM menus")).rows;
  const ma = [[], []];
  for (const m of menus)
    for (const a of MENU_ALLERGENS[`${m.category}/${m.name}`] || []) {
      if (!ids.has(a)) throw new Error(`food-info.js: 알 수 없는 알레르기 유발물질 "${a}"`);
      ma[0].push(m.id);
      ma[1].push(ids.get(a));
    }
  const co = [[], [], [], []];
  for (const [category, items] of Object.entries(ORIGINS))
    items.forEach(([ingredient, origin], i) => [category, ingredient, origin, i].forEach((v, k) => co[k].push(v)));
  await c.query("DELETE FROM menu_allergens");
  await c.query("DELETE FROM category_origins");
  await c.query("INSERT INTO menu_allergens SELECT * FROM unnest($1::int[], $2::int[])", ma);
  await c.query(
    `INSERT INTO category_origins (category, ingredient, origin, sort_order)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[])`,
    co,
  );
}

// 스키마 적용 + 초기 데이터 + 식품 정보 동기화를 하나의 트랜잭션으로
async function init(pool) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1)", [INIT_LOCK]);
    await c.query(SCHEMA);
    await seed(c);
    await syncFoodInfo(c);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// DATABASE_URL 로 연결 풀을 만든다. pool.ready() 는 첫 호출 때 한 번만 초기화하고, 실패하면 다음 호출에 다시 시도한다.
function open(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL 이 설정되지 않았습니다. PostgreSQL 연결 문자열을 환경변수로 넣어주세요.");
  // 서버리스(Vercel)는 인스턴스가 여러 개 뜰 수 있어 인스턴스당 연결 수를 적게 둔다
  const pool = new Pool({ connectionString: url, max: process.env.VERCEL ? 3 : 10 });
  let ready = null;
  pool.ready = () =>
    (ready ??= init(pool).catch((e) => {
      ready = null;
      throw e;
    }));
  return pool;
}

module.exports = { open };
