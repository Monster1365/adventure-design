// HTTP API 라우팅. 데이터 처리는 store.js, 인증은 auth.js 에 위임한다.
const path = require("path");
const express = require("express");
const { createStore, AppError } = require("./store");
const { authRoutes, sessionMiddleware, requireAuth } = require("./auth");
const { ALLERGENS_VERIFIED } = require("./food-info");

const { version: APP_VERSION } = require("../package.json");

const PAY_METHODS = ["카드결제", "카카오페이", "네이버페이", "토스페이"];

function createApp(db) {
  const store = createStore(db);
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
  app.use(express.json({ limit: "32kb" }));
  app.use(sessionMiddleware(store));
  app.use("/api", api);
  app.use(express.static(path.join(__dirname, "..", "public")));

  authRoutes(api, store);

  /* 공개 API */
  // 로그인 여부 확인용: 비로그인이면 user 가 null
  api.get("/me", (req, res) => res.json({ user: req.user }));
  api.get("/menus", (req, res) =>
    res.json({ menus: store.listMenus(req.query.sort || "default", req.user?.id) }),
  );
  api.get("/menus/:id/reviews", (req, res) => {
    const menuId = id(req.params.id);
    res.json({
      menu: store.getMenu(menuId),
      reviews: store.listReviews(menuId),
      me: req.user ? store.reviewEligibility(req.user.id, menuId) : null,
    });
  });
  api.get("/stats/menu-orders", (req, res) => res.json({ stats: store.menuOrderStats() }));
  api.get("/crowd", (req, res) => res.json(store.crowd()));
  api.get("/food-info", (req, res) => res.json({ allergensVerified: ALLERGENS_VERIFIED, ...store.foodInfo() }));
  api.get("/app-info", (req, res) => res.json({ version: APP_VERSION }));
  api.get("/pay-methods", (req, res) => res.json({ payMethods: PAY_METHODS }));

  /* 로그인 필요 API */
  api.get("/orders", requireAuth, (req, res) => res.json({ orders: store.listOrders(req.user.id) }));
  api.post("/orders", requireAuth, (req, res) => {
    const { items, payMethod } = req.body || {};
    if (!PAY_METHODS.includes(payMethod))
      throw new AppError(400, "bad_pay", "결제수단을 선택해주세요.");
    res.status(201).json({ order: store.placeOrder(req.user.id, items, payMethod) });
  });
  api.post("/orders/:id/reorder", requireAuth, (req, res) =>
    res.json(store.reorder(req.user.id, id(req.params.id), req.body?.cart)),
  );

  api.get("/me/reviews", requireAuth, (req, res) =>
    res.json({ reviews: store.listMyReviews(req.user.id) }),
  );
  api.get("/me/reviewable", requireAuth, (req, res) =>
    res.json({ menus: store.reviewableMenus(req.user.id) }),
  );
  api.post("/menus/:id/reviews", requireAuth, (req, res) =>
    res.status(201).json({ review: store.createReview(req.user.id, id(req.params.id), req.body || {}) }),
  );
  api.put("/reviews/:id", requireAuth, (req, res) =>
    res.json({ review: store.updateReview(req.user.id, id(req.params.id), req.body || {}) }),
  );
  api.delete("/reviews/:id", requireAuth, (req, res) => {
    store.deleteReview(req.user.id, id(req.params.id));
    res.status(204).end();
  });

  api.get("/favorites", requireAuth, (req, res) =>
    res.json({ favorites: store.listFavorites(req.user.id) }),
  );
  api.put("/favorites/:menuId", requireAuth, (req, res) =>
    res.json(store.setFavorite(req.user.id, id(req.params.menuId), true)),
  );
  api.delete("/favorites/:menuId", requireAuth, (req, res) =>
    res.json(store.setFavorite(req.user.id, id(req.params.menuId), false)),
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
