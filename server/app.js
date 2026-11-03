// HTTP API 라우팅. 데이터 처리는 store.js, 인증은 auth.js 에 위임한다.
const path = require("path");
const express = require("express");
const { createStore, AppError } = require("./store");
const { authRoutes, sessionMiddleware, requireAuth } = require("./auth");
const { ALLERGENS_VERIFIED } = require("./food-info");

const { version: APP_VERSION } = require("../package.json");

const PAY_METHODS = ["카드결제", "카카오페이", "네이버페이", "토스페이"];

function createApp(pool) {
  const store = createStore(pool);
  const app = express();
  const api = express.Router();
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new AppError(400, "bad_id", "잘못된 요청입니다.");
    return n;
  };

  app.disable("x-powered-by");
  // Vercel 프록시 뒤에서 https 를 인식하도록 (OAuth redirect_uri, Secure 쿠키)
  if (process.env.VERCEL) app.set("trust proxy", true);
  app.use("/api", api);
  app.use(express.static(path.join(__dirname, "..", "public")));

  // API 공통: 첫 요청 때 DB 초기화(스키마·초기 데이터) → 본문 파싱 → 세션으로 req.user
  api.use(async (req, res, next) => {
    await pool.ready();
    next();
  });
  api.use(express.json({ limit: "32kb" }));
  api.use(sessionMiddleware(store));

  authRoutes(api, store);

  /* 공개 API */
  // 로그인 여부 확인용: 비로그인이면 user 가 null
  api.get("/me", (req, res) => res.json({ user: req.user }));
  api.get("/menus", async (req, res) =>
    res.json({ menus: await store.listMenus(req.query.sort || "default", req.user?.id) }),
  );
  api.get("/menus/:id/reviews", async (req, res) => {
    const menuId = id(req.params.id);
    res.json({
      menu: await store.getMenu(menuId),
      reviews: await store.listReviews(menuId),
      me: req.user ? await store.reviewEligibility(req.user.id, menuId) : null,
    });
  });
  api.get("/stats/menu-orders", async (req, res) => res.json({ stats: await store.menuOrderStats() }));
  api.get("/crowd", async (req, res) => res.json(await store.crowd()));
  api.get("/food-info", async (req, res) =>
    res.json({ allergensVerified: ALLERGENS_VERIFIED, ...(await store.foodInfo()) }),
  );
  api.get("/app-info", (req, res) => res.json({ version: APP_VERSION }));
  api.get("/pay-methods", (req, res) => res.json({ payMethods: PAY_METHODS }));

  /* 로그인 필요 API */
  api.get("/orders", requireAuth, async (req, res) => res.json({ orders: await store.listOrders(req.user.id) }));
  api.post("/orders", requireAuth, async (req, res) => {
    const { items, payMethod } = req.body || {};
    if (!PAY_METHODS.includes(payMethod))
      throw new AppError(400, "bad_pay", "결제수단을 선택해주세요.");
    res.status(201).json({ order: await store.placeOrder(req.user.id, items, payMethod) });
  });
  api.post("/orders/:id/reorder", requireAuth, async (req, res) =>
    res.json(await store.reorder(req.user.id, id(req.params.id), req.body?.cart)),
  );

  api.get("/me/reviews", requireAuth, async (req, res) =>
    res.json({ reviews: await store.listMyReviews(req.user.id) }),
  );
  api.get("/me/reviewable", requireAuth, async (req, res) =>
    res.json({ menus: await store.reviewableMenus(req.user.id) }),
  );
  api.post("/menus/:id/reviews", requireAuth, async (req, res) =>
    res.status(201).json({ review: await store.createReview(req.user.id, id(req.params.id), req.body || {}) }),
  );
  api.put("/reviews/:id", requireAuth, async (req, res) =>
    res.json({ review: await store.updateReview(req.user.id, id(req.params.id), req.body || {}) }),
  );
  api.delete("/reviews/:id", requireAuth, async (req, res) => {
    await store.deleteReview(req.user.id, id(req.params.id));
    res.status(204).end();
  });

  api.get("/favorites", requireAuth, async (req, res) =>
    res.json({ favorites: await store.listFavorites(req.user.id) }),
  );
  api.put("/favorites/:menuId", requireAuth, async (req, res) =>
    res.json(await store.setFavorite(req.user.id, id(req.params.menuId), true)),
  );
  api.delete("/favorites/:menuId", requireAuth, async (req, res) =>
    res.json(await store.setFavorite(req.user.id, id(req.params.menuId), false)),
  );

  api.use((req, res) => res.status(404).json({ error: "not_found", message: "요청한 API가 없습니다." }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof AppError)
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "bad_json", message: "잘못된 요청 형식입니다." });
    console.error(err);
    res.status(500).json({ error: "server_error", message: "서버 오류가 발생했어요. 잠시 후 다시 시도해주세요." });
  });

  return app;
}

module.exports = { createApp, PAY_METHODS };
