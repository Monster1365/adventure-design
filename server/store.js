// 데이터베이스 접근 계층 (PostgreSQL). 라우터(app.js)와 인증(auth.js)은 이 모듈만 통해 DB 를 다룬다.
// 모든 함수는 Promise 를 돌려준다. 컬럼 별칭은 따옴표로 감싸야 camelCase 가 유지된다.
const crypto = require("crypto");

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const SESSION_DAYS = 30;
const CROWD_MAX = 100; // 혼잡도 100% 에 해당하는 앱 주문 수
const TZ = "'Asia/Seoul'"; // "오늘"의 기준 시간대
// 한국 시간 기준 오늘 들어온 주문인지 (매일 자정에 0부터 다시 세는 집계에 사용)
const isToday = (col) => `(${col} AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date`;
const MAX_QTY = 99;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const SORTS = {
  // 별점 정렬: 리뷰 없는 메뉴(rating_avg IS NULL)는 항상 맨 뒤, 동점이면 리뷰 수가 많은 쪽 먼저
  default: "sort_order",
  price_asc: "price ASC, sort_order",
  price_desc: "price DESC, sort_order",
  rating_desc: "rating_avg DESC NULLS LAST, review_count DESC, sort_order",
  rating_asc: "rating_avg ASC NULLS LAST, review_count DESC, sort_order",
};

function createStore(pool) {
  const rows = async (sql, params, c = pool) => (await c.query(sql, params)).rows;
  const row = async (sql, params, c = pool) => (await c.query(sql, params)).rows[0];

  // 하나의 연결에서 BEGIN … COMMIT. 예외가 나면 전체 롤백.
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  const menuCols = (t = "") =>
    `${t}id, ${t}category, ${t}name, ${t}description, ${t}price, ${t}image, ${t}stock,
     ${t}rating_avg AS "ratingAvg", ${t}review_count AS "reviewCount"`;
  const userCols = `u.id, u.provider, u.name, u.email, u.profile_image AS "profileImage", u.created_at AS "createdAt"`;

  /* ---------- 사용자 / 세션 ---------- */

  // 외부 인증 공급자에서 받은 프로필로 사용자 조회 또는 생성
  function upsertUser({ provider, providerUserId, name, email, profileImage }) {
    return row(
      `INSERT INTO users AS u (provider, provider_user_id, name, email, profile_image)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         name = excluded.name,
         email = COALESCE(excluded.email, u.email),
         profile_image = COALESCE(excluded.profile_image, u.profile_image),
         last_login_at = now()
       RETURNING ${userCols}`,
      [provider, String(providerUserId), name, email ?? null, profileImage ?? null],
    );
  }

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), userId, SESSION_DAYS],
    );
    return { token, maxAgeMs: SESSION_DAYS * 864e5 };
  }

  async function userBySession(token) {
    if (!token) return null;
    return (
      (await row(
        `SELECT ${userCols} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(token)],
      )) || null
    );
  }

  async function deleteSession(token) {
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  }

  /* ---------- 메뉴 ---------- */

  async function listMenus(sort = "default", userId = null) {
    const order = SORTS[sort];
    if (!order) throw new AppError(400, "bad_sort", "지원하지 않는 정렬 기준입니다.");
    const menus = await rows(`SELECT ${menuCols()} FROM menus ORDER BY ${order}`);
    if (userId) {
      const fav = new Set(
        (await rows("SELECT menu_id FROM favorites WHERE user_id = $1", [userId])).map((r) => r.menu_id),
      );
      menus.forEach((m) => (m.favorite = fav.has(m.id)));
    }
    return menus;
  }

  async function getMenu(id, c = pool) {
    const m = await row(`SELECT ${menuCols()} FROM menus WHERE id = $1`, [id], c);
    if (!m) throw new AppError(404, "menu_not_found", "메뉴를 찾을 수 없습니다.");
    return m;
  }

  /* ---------- 주문 ---------- */

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
  async function placeOrder(userId, items, payMethod) {
    if (!payMethod || typeof payMethod !== "string")
      throw new AppError(400, "bad_pay", "결제수단을 선택해주세요.");
    const merged = normalizeItems(items);
    return tx(async (c) => {
      // 주문할 메뉴 행을 잠가 동시 주문이 같은 재고를 두 번 쓰지 못하게 한다
      const found = await rows(
        "SELECT id, name, price, stock FROM menus WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
        [[...merged.keys()]],
        c,
      );
      if (found.length !== merged.size)
        throw new AppError(404, "menu_not_found", "존재하지 않는 메뉴가 포함되어 있습니다.");
      const byId = new Map(found.map((m) => [m.id, m]));
      const lines = [...merged].map(([id, quantity]) => ({ ...byId.get(id), quantity }));
      const shortage = lines
        .filter((l) => l.stock < l.quantity)
        .map((l) => ({ menuId: l.id, name: l.name, stock: l.stock, requested: l.quantity }));
      if (shortage.length)
        throw new AppError(
          409,
          "out_of_stock",
          `재고가 부족해요: ${shortage.map((s) => `${s.name}(남은 수량 ${s.stock}개)`).join(", ")}`,
          { shortage },
        );
      const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
      const { id } = await row(
        `INSERT INTO orders (user_id, total_amount, pay_method, ticket_no) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, total, payMethod, 100 + crypto.randomInt(900)],
        c,
      );
      await c.query(
        `UPDATE menus m SET stock = m.stock - t.q
         FROM unnest($1::int[], $2::int[]) AS t(id, q) WHERE m.id = t.id`,
        [lines.map((l) => l.id), lines.map((l) => l.quantity)],
      );
      await c.query(
        `INSERT INTO order_items (order_id, menu_id, quantity, unit_price)
         SELECT $1::int, * FROM unnest($2::int[], $3::int[], $4::int[])`,
        [id, lines.map((l) => l.id), lines.map((l) => l.quantity), lines.map((l) => l.price)],
      );
      return getOrder(userId, id, c);
    });
  }

  async function hydrateOrders(orders, c = pool) {
    if (!orders.length) return orders;
    const items = await rows(
      `SELECT oi.order_id AS "orderId", oi.menu_id AS "menuId", m.name, m.category, m.image,
              oi.quantity, oi.unit_price AS "unitPrice"
       FROM order_items oi JOIN menus m ON m.id = oi.menu_id
       WHERE oi.order_id = ANY($1::int[])
       ORDER BY m.sort_order`,
      [orders.map((o) => o.id)],
      c,
    );
    const by = new Map(orders.map((o) => [o.id, (o.items = [])]));
    items.forEach(({ orderId, ...it }) => by.get(orderId).push(it));
    return orders;
  }

  const orderCols = `id, status, total_amount AS "totalAmount", pay_method AS "payMethod", ticket_no AS "ticketNo",
                     ordered_at AS "orderedAt", cancelled_at AS "cancelledAt"`;

  async function listOrders(userId, limit = 30) {
    return hydrateOrders(
      await rows(
        `SELECT ${orderCols} FROM orders WHERE user_id = $1 ORDER BY ordered_at DESC, id DESC LIMIT $2`,
        [userId, limit],
      ),
    );
  }

  // 다른 사용자의 주문은 존재 여부도 드러내지 않도록 404
  async function getOrder(userId, orderId, c = pool) {
    const o = await row(`SELECT ${orderCols} FROM orders WHERE id = $1 AND user_id = $2`, [orderId, userId], c);
    if (!o) throw new AppError(404, "order_not_found", "주문을 찾을 수 없습니다.");
    return (await hydrateOrders([o], c))[0];
  }

  // 과거 주문을 현재 장바구니에 합친다. 현재 가격/재고 기준, 품절은 제외, 재고 초과분은 잘라낸다.
  async function reorder(userId, orderId, cart = {}) {
    const o = await getOrder(userId, orderId);
    const next = {};
    for (const [k, v] of Object.entries(cart || {})) {
      const q = Number(v);
      if (Number.isInteger(Number(k)) && Number.isInteger(q) && q > 0) next[k] = q;
    }
    const results = [];
    for (const it of o.items) {
      const m = await getMenu(it.menuId);
      const inCart = next[m.id] || 0;
      const limit = Math.min(m.stock, MAX_QTY);
      const after = Math.max(inCart, Math.min(inCart + it.quantity, limit));
      const added = after - inCart;
      if (after) next[m.id] = after;
      const status = m.stock === 0 ? "sold_out" : added === it.quantity ? "added" : added ? "partial" : "limit";
      results.push({ menuId: m.id, name: m.name, price: m.price, requested: it.quantity, added, inCart: after, status });
    }
    return { cart: next, results };
  }

  /* ---------- 메뉴별 주문 집계 ---------- */

  // 오늘(한국 시간) 주문만 집계해 매일 자정에 0부터 다시 센다. 취소된 주문은 제외.
  // 주문 건수 = 해당 메뉴(카테고리)가 포함된 주문 수, 주문 수량 = 수량 합.
  // 한 주문에 같은 카테고리 메뉴가 여러 개 있어도 카테고리 주문 건수는 1건이다.
  async function menuOrderStats() {
    const from = `FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelled' AND ${isToday("o.ordered_at")}
         JOIN menus  m ON m.id = oi.menu_id`;
    const counts = `COUNT(DISTINCT oi.order_id) AS "orderCount", COALESCE(SUM(oi.quantity), 0) AS quantity`;
    const total = await row(`SELECT ${counts} ${from}`);
    const menus = await rows(
      `SELECT m.id, m.name, m.category, m.image, ${counts} ${from}
       GROUP BY m.id ORDER BY "orderCount" DESC, quantity DESC, m.sort_order`,
    );
    const categories = (
      await rows(
        `SELECT m.category, ${counts} ${from}
         GROUP BY m.category ORDER BY "orderCount" DESC, quantity DESC, MIN(m.sort_order)`,
      )
    ).map((c) => ({ ...c, menus: menus.filter((m) => m.category === c.category) }));
    return { total, categories };
  }

  /* ---------- 혼잡도 ---------- */

  // 오늘(한국 시간) 들어온 앱 주문 수 기준. 주문 1건당 1%, 100건이면 100%. 자정에 0부터 다시 센다.
  async function crowd() {
    const today = `${isToday("ordered_at")} AND status <> 'cancelled'`;
    const { appOrders, hourNow } = await row(
      `SELECT (SELECT COUNT(*) FROM orders WHERE ${today}) AS "appOrders",
              EXTRACT(HOUR FROM now() AT TIME ZONE ${TZ})::int AS "hourNow"`,
    );
    const hourly = await rows(
      `SELECT EXTRACT(HOUR FROM ordered_at AT TIME ZONE ${TZ})::int AS hour, COUNT(*) AS count
       FROM orders WHERE ${today} GROUP BY hour ORDER BY hour`,
    );
    return {
      appOrders,
      max: CROWD_MAX,
      percent: Math.min(100, Math.round((appOrders / CROWD_MAX) * 100)),
      hourly,
      hourNow,
    };
  }

  /* ---------- 리뷰 ---------- */

  // 작성자는 이름·ID 대신 메뉴별 작성 순서로 '익명1', '익명2' … 로만 내보낸다
  const reviewCols = `r.id, r.menu_id AS "menuId", r.rating, r.content,
                      r.created_at AS "createdAt", r.updated_at AS "updatedAt",
                      '익명' || (SELECT COUNT(*) FROM reviews r2
                                WHERE r2.menu_id = r.menu_id AND (r2.created_at, r2.id) <= (r.created_at, r.id))
                        AS "authorName"`;

  async function listReviews(menuId) {
    await getMenu(menuId);
    return rows(
      `SELECT ${reviewCols} FROM reviews r
       WHERE r.menu_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
      [menuId],
    );
  }

  function listMyReviews(userId) {
    return rows(
      `SELECT ${reviewCols}, m.name AS "menuName", m.image AS "menuImage"
       FROM reviews r JOIN menus m ON m.id = r.menu_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
      [userId],
    );
  }

  // 리뷰 쓰기 화면: 내가 주문했던(취소 제외) 메뉴와 작성 여부. 아직 안 쓴 메뉴가 먼저.
  function reviewableMenus(userId) {
    return rows(
      `SELECT m.id, m.name, m.category, m.image,
              COUNT(DISTINCT o.id) AS "orderCount", MAX(o.ordered_at) AS "lastOrderedAt",
              r.id AS "reviewId", r.rating
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN menus m ON m.id = oi.menu_id
       LEFT JOIN reviews r ON r.menu_id = m.id AND r.user_id = o.user_id
       WHERE o.user_id = $1 AND o.status <> 'cancelled'
       GROUP BY m.id, r.id, r.rating
       ORDER BY r.id IS NOT NULL, MAX(o.ordered_at) DESC, m.sort_order`,
      [userId],
    );
  }

  async function hasOrdered(userId, menuId) {
    return !!(await row(
      `SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1 AND oi.menu_id = $2 AND o.status <> 'cancelled' LIMIT 1`,
      [userId, menuId],
    ));
  }

  async function reviewEligibility(userId, menuId) {
    await getMenu(menuId);
    const mine = await row(
      `SELECT ${reviewCols} FROM reviews r WHERE r.user_id = $1 AND r.menu_id = $2`,
      [userId, menuId],
    );
    return { ordered: await hasOrdered(userId, menuId), review: mine || null };
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
    return row(`SELECT ${reviewCols} FROM reviews r WHERE r.id = $1`, [id]);
  }

  async function createReview(userId, menuId, body) {
    await getMenu(menuId);
    const { r, c } = validateReview(body);
    if (!(await hasOrdered(userId, menuId)))
      throw new AppError(403, "not_ordered", "주문한 메뉴에만 리뷰를 남길 수 있어요.");
    try {
      const { id } = await row(
        "INSERT INTO reviews (user_id, menu_id, rating, content) VALUES ($1, $2, $3, $4) RETURNING id",
        [userId, menuId, r, c],
      );
      return getReview(id);
    } catch (e) {
      if (e.code === "23505")
        throw new AppError(409, "duplicate_review", "이미 이 메뉴에 리뷰를 작성했어요. 기존 리뷰를 수정해주세요.");
      throw e;
    }
  }

  async function ownReview(userId, reviewId) {
    const owner = await row("SELECT user_id FROM reviews WHERE id = $1", [reviewId]);
    if (!owner || owner.user_id !== userId) throw new AppError(404, "review_not_found", "리뷰를 찾을 수 없습니다.");
  }

  async function updateReview(userId, reviewId, body) {
    await ownReview(userId, reviewId);
    const { r, c } = validateReview(body);
    await pool.query("UPDATE reviews SET rating = $1, content = $2, updated_at = now() WHERE id = $3", [
      r,
      c,
      reviewId,
    ]);
    return getReview(reviewId);
  }

  async function deleteReview(userId, reviewId) {
    await ownReview(userId, reviewId);
    await pool.query("DELETE FROM reviews WHERE id = $1", [reviewId]);
  }

  /* ---------- 식품 정보 ---------- */

  async function foodInfo() {
    const menus = await rows("SELECT id, category, name, image FROM menus ORDER BY sort_order");
    const by = new Map(menus.map((m) => [m.id, Object.assign(m, { allergens: [] })]));
    (
      await rows(
        `SELECT ma.menu_id AS "menuId", a.name FROM menu_allergens ma
         JOIN allergens a ON a.id = ma.allergen_id ORDER BY a.id`,
      )
    ).forEach((r) => by.get(r.menuId).allergens.push(r.name));
    const origins = {};
    (await rows("SELECT category, ingredient, origin FROM category_origins ORDER BY category, sort_order")).forEach(
      ({ category, ...o }) => (origins[category] ??= []).push(o),
    );
    const allergens = (await rows("SELECT name FROM allergens ORDER BY id")).map((r) => r.name);
    return { allergens, menus, origins };
  }

  /* ---------- 즐겨찾기 ---------- */

  function listFavorites(userId) {
    return rows(
      `SELECT ${menuCols("m.")}, f.created_at AS "favoritedAt"
       FROM favorites f JOIN menus m ON m.id = f.menu_id
       WHERE f.user_id = $1 ORDER BY f.created_at DESC, m.sort_order`,
      [userId],
    );
  }

  async function setFavorite(userId, menuId, on) {
    await getMenu(menuId);
    if (on)
      await pool.query("INSERT INTO favorites (user_id, menu_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
        userId,
        menuId,
      ]);
    else await pool.query("DELETE FROM favorites WHERE user_id = $1 AND menu_id = $2", [userId, menuId]);
    return { menuId, favorite: !!on };
  }

  return {
    upsertUser,
    createSession,
    userBySession,
    deleteSession,
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
    reviewEligibility,
    createReview,
    updateReview,
    deleteReview,
    foodInfo,
    listFavorites,
    setFavorite,
  };
}

module.exports = { createStore, AppError, MAX_QTY };
