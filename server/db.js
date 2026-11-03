const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

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

function seed(db) {
  if (db.prepare("SELECT COUNT(*) AS n FROM menus").get().n) return;
  const ins = db.prepare(
    "INSERT INTO menus (category, name, price, image, stock, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    let i = 0;
    for (const [cat, items] of Object.entries(SEED_MENUS))
      for (const [name, price, image, stock = SEED_STOCK] of items)
        ins.run(cat, name, price, image, stock, i++);
  })();
}

// food-info.js 내용으로 식품 정보 테이블을 다시 맞춘다 (파일이 원본)
function syncFoodInfo(db) {
  const { ALLERGENS, MENU_ALLERGENS, ORIGINS } = require("./food-info");
  const insAllergen = db.prepare("INSERT OR IGNORE INTO allergens (name) VALUES (?)");
  const insMenuAllergen = db.prepare("INSERT INTO menu_allergens (menu_id, allergen_id) VALUES (?, ?)");
  const insOrigin = db.prepare(
    "INSERT INTO category_origins (category, ingredient, origin, sort_order) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    ALLERGENS.forEach((n) => insAllergen.run(n));
    const ids = new Map(db.prepare("SELECT name, id FROM allergens").all().map((r) => [r.name, r.id]));
    db.exec("DELETE FROM menu_allergens; DELETE FROM category_origins;");
    for (const m of db.prepare("SELECT id, category, name FROM menus").all())
      for (const a of MENU_ALLERGENS[`${m.category}/${m.name}`] || []) {
        if (!ids.has(a)) throw new Error(`food-info.js: 알 수 없는 알레르기 유발물질 "${a}"`);
        insMenuAllergen.run(m.id, ids.get(a));
      }
    for (const [category, items] of Object.entries(ORIGINS))
      items.forEach(([ingredient, origin], i) => insOrigin.run(category, ingredient, origin, i));
  })();
}

// Vercel 처럼 프로젝트 폴더에 쓸 수 없는 서버리스 환경에서는 임시 폴더를 쓴다
const DEFAULT_DB = process.env.VERCEL
  ? path.join(os.tmpdir(), "app.db")
  : path.join(__dirname, "..", "data", "app.db");

function open(file = process.env.DB_PATH || DEFAULT_DB) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  seed(db);
  syncFoodInfo(db);
  return db;
}

module.exports = { open };
