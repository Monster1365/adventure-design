// 데이터베이스 접근 계층. 라우터(app.js)는 이 모듈만 통해 DB 를 다룬다.
const crypto = require("crypto");

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CROWD_MAX = 100; // 혼잡도 100% 에 해당하는 앱 주문 수
const KST = "'+9 hours'"; // 하루 경계는 한국 시간 기준
const MAX_QTY = 99;

const SORTS = {
  // 별점 정렬: 리뷰 없는 메뉴(rating_avg IS NULL)는 항상 맨 뒤, 동점이면 리뷰 수가 많은 쪽 먼저
  default: "sort_order",
  price_asc: "price ASC, sort_order",
  price_desc: "price DESC, sort_order",
  rating_desc: "rating_avg IS NULL, rating_avg DESC, review_count DESC, sort_order",
  rating_asc: "rating_avg IS NULL, rating_avg ASC, review_count DESC, sort_order",
};

function createStore(db) {
  const menuCols = (t = "") =>
    `${t}id, ${t}category, ${t}name, ${t}description, ${t}price, ${t}image, ${t}stock,
     ${t}rating_avg AS ratingAvg, ${t}review_count AS reviewCount`;

  /* ---------- 사용자 ---------- */

  const userCols = "id, provider, name, email, profile_image AS profileImage, created_at AS createdAt";

  // 외부 인증 공급자에서 받은 프로필로 사용자 조회 또는 생성
  function upsertUser({ provider, providerUserId, name, email, profileImage }) {
    return db
      .prepare(
        `INSERT INTO users (provider, provider_user_id, name, email, profile_image)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_user_id) DO UPDATE SET
           name = excluded.name,
           email = COALESCE(excluded.email, users.email),
           profile_image = COALESCE(excluded.profile_image, users.profile_image),
           last_login_at = datetime('now')
         RETURNING ${userCols}`,
      )
      .get(provider, String(providerUserId), name, email ?? null, profileImage ?? null);
  }

  // 서명된 세션 쿠키의 사용자를 조회하고, 없으면(새 서버 인스턴스의 빈 DB 등) 그 정보로 만든다
  function ensureUser(profile) {
    return (
      db
        .prepare(`SELECT ${userCols} FROM users WHERE provider = ? AND provider_user_id = ?`)
        .get(profile.provider, String(profile.providerUserId)) || upsertUser(profile)
    );
  }

  /* ---------- 메뉴 ---------- */

  function listMenus(sort = "default", userId = null) {
    const order = SORTS[sort];
    if (!order) throw new AppError(400, "bad_sort", "지원하지 않는 정렬 기준입니다.");
    const rows = db.prepare(`SELECT ${menuCols()} FROM menus ORDER BY ${order}`).all();
    if (userId) {
      const fav = new Set(
        db.prepare("SELECT menu_id FROM favorites WHERE user_id = ?").pluck().all(userId),
      );
      rows.forEach((r) => (r.favorite = fav.has(r.id)));
    }
    return rows;
  }

  function getMenu(id) {
    const m = db.prepare(`SELECT ${menuCols()} FROM menus WHERE id = ?`).get(id);
    if (!m) throw new AppError(404, "menu_not_found", "메뉴를 찾을 수 없습니다.");
    return m;
  }

  /* ---------- 주문 ---------- */

  const insOrder = db.prepare(
    `INSERT INTO orders (user_id, total_amount, pay_method, ticket_no) VALUES (?, ?, ?, ?)
     RETURNING id`,
  );
  const insItem = db.prepare(
    "INSERT INTO order_items (order_id, menu_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
  );
  const takeStock = db.prepare("UPDATE menus SET stock = stock - ? WHERE id = ? AND stock >= ?");

  function normalizeItems(items) {
    if (!Array.isArray(items) || !items.length)
      throw new AppError(400, "empty_order", "주문할 메뉴가 없습니다.");
    const merged = new Map();
    for (const it of items) {
      const id = Number(it?.menuId);
      const q = Number(it?.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(q) || q < 1)
        throw new AppError(400, "bad_item", "주문 항목이 올바르지 않습니다.");
      merged.set(id, (merged.get(id) || 0) + q);
    }
    for (const q of merged.values())
      if (q > MAX_QTY)
        throw new AppError(400, "bad_item", `한 메뉴는 최대 ${MAX_QTY}개까지 주문할 수 있습니다.`);
    return merged;
  }

  // 가격/재고는 클라이언트 값이 아닌 DB 기준으로 검증. 하나라도 실패하면 전체 롤백.
  const placeOrder = db.transaction((userId, items, payMethod) => {
    if (!payMethod || typeof payMethod !== "string")
      throw new AppError(400, "bad_pay", "결제수단을 선택해주세요.");
    const merged = normalizeItems(items);
    const lines = [];
    const shortage = [];
    for (const [menuId, quantity] of merged) {
      const m = db.prepare("SELECT id, name, price, stock FROM menus WHERE id = ?").get(menuId);
      if (!m) throw new AppError(404, "menu_not_found", "존재하지 않는 메뉴가 포함되어 있습니다.");
      if (m.stock < quantity) shortage.push({ menuId, name: m.name, stock: m.stock, requested: quantity });
      lines.push({ ...m, quantity });
    }
    if (shortage.length)
      throw new AppError(
        409,
        "out_of_stock",
        `재고가 부족해요: ${shortage.map((s) => `${s.name}(남은 수량 ${s.stock}개)`).join(", ")}`,
        { shortage },
      );
    const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
    const ticket = 100 + crypto.randomInt(900);
    const { id } = insOrder.get(userId, total, payMethod, ticket);
    for (const l of lines) {
      // 조건부 차감: 동시 주문으로 재고가 바뀐 경우까지 방지
      if (takeStock.run(l.quantity, l.id, l.quantity).changes !== 1)
        throw new AppError(409, "out_of_stock", `재고가 부족해요: ${l.name}`);
      insItem.run(id, l.id, l.quantity, l.price);
    }
    return getOrder(userId, id);
  });

  function hydrateOrders(orders) {
    if (!orders.length) return orders;
    const items = db
      .prepare(
        `SELECT oi.order_id AS orderId, oi.menu_id AS menuId, m.name, m.category, m.image,
                oi.quantity, oi.unit_price AS unitPrice
         FROM order_items oi JOIN menus m ON m.id = oi.menu_id
         WHERE oi.order_id IN (${orders.map(() => "?").join(",")})
         ORDER BY m.sort_order`,
      )
      .all(...orders.map((o) => o.id));
    const by = new Map(orders.map((o) => [o.id, (o.items = [])]));
    items.forEach(({ orderId, ...it }) => by.get(orderId).push(it));
    return orders;
  }

  const orderCols =
    "id, status, total_amount AS totalAmount, pay_method AS payMethod, ticket_no AS ticketNo, ordered_at AS orderedAt, cancelled_at AS cancelledAt";

  function listOrders(userId, limit = 30) {
    return hydrateOrders(
      db
        .prepare(
          `SELECT ${orderCols} FROM orders WHERE user_id = ? ORDER BY ordered_at DESC, id DESC LIMIT ?`,
        )
        .all(userId, limit),
    );
  }

  // 다른 사용자의 주문은 존재 여부도 드러내지 않도록 404
  function getOrder(userId, orderId) {
    const o = db
      .prepare(`SELECT ${orderCols} FROM orders WHERE id = ? AND user_id = ?`)
      .get(orderId, userId);
    if (!o) throw new AppError(404, "order_not_found", "주문을 찾을 수 없습니다.");
    return hydrateOrders([o])[0];
  }

  // 과거 주문을 현재 장바구니에 합친다. 현재 가격/재고 기준, 품절은 제외, 재고 초과분은 잘라낸다.
  function reorder(userId, orderId, cart = {}) {
    const o = getOrder(userId, orderId);
    const next = {};
    for (const [k, v] of Object.entries(cart || {})) {
      const q = Number(v);
      if (Number.isInteger(Number(k)) && Number.isInteger(q) && q > 0) next[k] = q;
    }
    const results = o.items.map((it) => {
      const m = getMenu(it.menuId);
      const inCart = next[m.id] || 0;
      const limit = Math.min(m.stock, MAX_QTY);
      const after = Math.max(inCart, Math.min(inCart + it.quantity, limit));
      const added = after - inCart;
      if (after) next[m.id] = after;
      const status = m.stock === 0 ? "sold_out" : added === it.quantity ? "added" : added ? "partial" : "limit";
      return { menuId: m.id, name: m.name, price: m.price, requested: it.quantity, added, inCart: after, status };
    });
    return { cart: next, results };
  }

  /* ---------- 메뉴별 주문 집계 ---------- */

  // 주문 건수 = 해당 메뉴(카테고리)가 포함된 주문 수, 주문 수량 = 수량 합. 취소된 주문은 제외.
  // 한 주문에 같은 카테고리 메뉴가 여러 개 있어도 카테고리 주문 건수는 1건이다.
  function menuOrderStats() {
    const from = `FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelled'
         JOIN menus  m ON m.id = oi.menu_id`;
    const counts = "COUNT(DISTINCT oi.order_id) AS orderCount, COALESCE(SUM(oi.quantity), 0) AS quantity";
    const total = db.prepare(`SELECT ${counts} ${from}`).get();
    const menus = db
      .prepare(
        `SELECT m.id, m.name, m.category, m.image, ${counts} ${from}
         GROUP BY m.id ORDER BY orderCount DESC, quantity DESC, m.sort_order`,
      )
      .all();
    const categories = db
      .prepare(
        `SELECT m.category, ${counts} ${from}
         GROUP BY m.category ORDER BY orderCount DESC, quantity DESC, MIN(m.sort_order)`,
      )
      .all()
      .map((c) => ({ ...c, menus: menus.filter((m) => m.category === c.category) }));
    return { total, categories };
  }

  /* ---------- 혼잡도 ---------- */

  // 오늘(한국 시간) 들어온 앱 주문 수 기준. 주문 1건당 1%, 100건이면 100%. 자정에 0부터 다시 센다.
  function crowd() {
    const today = `date(ordered_at, ${KST}) = date('now', ${KST}) AND status <> 'cancelled'`;
    const appOrders = db.prepare(`SELECT COUNT(*) FROM orders WHERE ${today}`).pluck().get();
    const hourly = db
      .prepare(
        `SELECT CAST(strftime('%H', ordered_at, ${KST}) AS INTEGER) AS hour, COUNT(*) AS count
         FROM orders WHERE ${today} GROUP BY hour ORDER BY hour`,
      )
      .all();
    const hourNow = db.prepare(`SELECT CAST(strftime('%H', 'now', ${KST}) AS INTEGER)`).pluck().get();
    return {
      appOrders,
      max: CROWD_MAX,
      percent: Math.min(100, Math.round((appOrders / CROWD_MAX) * 100)),
      hourly,
      hourNow,
    };
  }

  /* ---------- 리뷰 ---------- */

  const reviewCols = `r.id, r.menu_id AS menuId, r.user_id AS userId, u.name AS userName, r.rating, r.content,
                      r.created_at AS createdAt, r.updated_at AS updatedAt`;

  function listReviews(menuId) {
    getMenu(menuId);
    return db
      .prepare(
        `SELECT ${reviewCols} FROM reviews r JOIN users u ON u.id = r.user_id
         WHERE r.menu_id = ? ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(menuId);
  }

  function listMyReviews(userId) {
    return db
      .prepare(
        `SELECT ${reviewCols}, m.name AS menuName, m.image AS menuImage
         FROM reviews r JOIN users u ON u.id = r.user_id JOIN menus m ON m.id = r.menu_id
         WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(userId);
  }

  function hasOrdered(userId, menuId) {
    return !!db
      .prepare(
        `SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.user_id = ? AND oi.menu_id = ? AND o.status <> 'cancelled' LIMIT 1`,
      )
      .get(userId, menuId);
  }

  function reviewEligibility(userId, menuId) {
    getMenu(menuId);
    const mine = db
      .prepare(`SELECT ${reviewCols} FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? AND r.menu_id = ?`)
      .get(userId, menuId);
    return { ordered: hasOrdered(userId, menuId), review: mine || null };
  }

  // 리뷰 쓰기 화면: 내가 주문했던(취소 제외) 메뉴와 작성 여부. 아직 안 쓴 메뉴가 먼저.
  function reviewableMenus(userId) {
    return db
      .prepare(
        `SELECT m.id, m.name, m.category, m.image,
                COUNT(DISTINCT o.id) AS orderCount, MAX(o.ordered_at) AS lastOrderedAt,
                r.id AS reviewId, r.rating
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN menus m ON m.id = oi.menu_id
         LEFT JOIN reviews r ON r.menu_id = m.id AND r.user_id = o.user_id
         WHERE o.user_id = ? AND o.status <> 'cancelled'
         GROUP BY m.id
         ORDER BY r.id IS NOT NULL, lastOrderedAt DESC, m.sort_order`,
      )
      .all(userId);
  }

  function validateReview({ rating, content }) {
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5)
      throw new AppError(400, "bad_rating", "별점은 1~5점 사이로 선택해주세요.");
    const c = typeof content === "string" ? content.trim() : "";
    if (!c) throw new AppError(400, "bad_content", "리뷰 내용을 입력해주세요.");
    if (c.length > 500) throw new AppError(400, "bad_content", "리뷰는 500자 이내로 작성해주세요.");
    return { r, c };
  }

  function getReview(id) {
    return db
      .prepare(`SELECT ${reviewCols} FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.id = ?`)
      .get(id);
  }

  const createReview = db.transaction((userId, menuId, body) => {
    getMenu(menuId);
    const { r, c } = validateReview(body);
    if (!hasOrdered(userId, menuId))
      throw new AppError(403, "not_ordered", "주문한 메뉴에만 리뷰를 남길 수 있어요.");
    try {
      const { id } = db
        .prepare("INSERT INTO reviews (user_id, menu_id, rating, content) VALUES (?, ?, ?, ?) RETURNING id")
        .get(userId, menuId, r, c);
      return getReview(id);
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
        throw new AppError(409, "duplicate_review", "이미 이 메뉴에 리뷰를 작성했어요. 기존 리뷰를 수정해주세요.");
      throw e;
    }
  });

  function ownReview(userId, reviewId) {
    const rv = getReview(reviewId);
    if (!rv || rv.userId !== userId)
      throw new AppError(404, "review_not_found", "리뷰를 찾을 수 없습니다.");
    return rv;
  }

  function updateReview(userId, reviewId, body) {
    ownReview(userId, reviewId);
    const { r, c } = validateReview(body);
    db.prepare(
      "UPDATE reviews SET rating = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(r, c, reviewId);
    return getReview(reviewId);
  }

  function deleteReview(userId, reviewId) {
    ownReview(userId, reviewId);
    db.prepare("DELETE FROM reviews WHERE id = ?").run(reviewId);
  }

  /* ---------- 식품 정보 ---------- */

  function foodInfo() {
    const menus = db.prepare("SELECT id, category, name, image FROM menus ORDER BY sort_order").all();
    const by = new Map(menus.map((m) => [m.id, Object.assign(m, { allergens: [] })]));
    db.prepare(
      `SELECT ma.menu_id AS menuId, a.name FROM menu_allergens ma
       JOIN allergens a ON a.id = ma.allergen_id ORDER BY a.id`,
    )
      .all()
      .forEach((r) => by.get(r.menuId).allergens.push(r.name));
    const origins = {};
    db.prepare("SELECT category, ingredient, origin FROM category_origins ORDER BY category, sort_order")
      .all()
      .forEach(({ category, ...o }) => (origins[category] ??= []).push(o));
    return { allergens: db.prepare("SELECT name FROM allergens ORDER BY id").pluck().all(), menus, origins };
  }

  /* ---------- 즐겨찾기 ---------- */

  function listFavorites(userId) {
    return db
      .prepare(
        `SELECT ${menuCols("m.")}, f.created_at AS favoritedAt
         FROM favorites f JOIN menus m ON m.id = f.menu_id
         WHERE f.user_id = ? ORDER BY f.created_at DESC, m.sort_order`,
      )
      .all(userId);
  }

  function setFavorite(userId, menuId, on) {
    getMenu(menuId);
    if (on)
      db.prepare("INSERT OR IGNORE INTO favorites (user_id, menu_id) VALUES (?, ?)").run(userId, menuId);
    else db.prepare("DELETE FROM favorites WHERE user_id = ? AND menu_id = ?").run(userId, menuId);
    return { menuId, favorite: !!on };
  }

  return {
    upsertUser,
    ensureUser,
    listMenus,
    getMenu,
    placeOrder,
    listOrders,
    getOrder,
    reorder,
    menuOrderStats,
    crowd,
    listReviews,
    listMyReviews,
    reviewableMenus,
    foodInfo,
    reviewEligibility,
    createReview,
    updateReview,
    deleteReview,
    listFavorites,
    setFavorite,
  };
}

module.exports = { createStore, AppError, MAX_QTY };
