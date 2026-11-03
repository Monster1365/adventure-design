// node --test test/
// 실제 PostgreSQL 로 서버를 띄워 HTTP 요청으로 검증한다.
// TEST_DATABASE_URL 이 없으면 embedded-postgres 로 임시 PostgreSQL 을 띄우고 끝나면 지운다.
// 로그인은 OAuth 콜백이 내부적으로 하는 것과 같은 store.upsertUser + createSession 으로 세션을 만든다.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { open } = require("../server/db");
const { createApp } = require("../server/app");
const { createStore } = require("../server/store");

let pg, pool, server, base, store;

before(async () => {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haksik-pg-"));
    const port = 54000 + Math.floor(Math.random() * 1000);
    pg = new EmbeddedPostgres({ databaseDir: dir, port, user: "test", password: "test", persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("haksik");
    url = `postgres://test:test@localhost:${port}/haksik`;
  }
  pool = open(url);
  await pool.ready();
  store = createStore(pool);
  server = createApp(pool).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await pool?.end();
  await pg?.stop();
});

const sql = async (text, params) => (await pool.query(text, params)).rows;
const value = async (text, params) => Object.values((await sql(text, params))[0])[0];

async function login(providerUserId, name = providerUserId) {
  const u = await store.upsertUser({ provider: "kakao", providerUserId, name });
  return { id: u.id, cookie: `sid=${(await store.createSession(u.id)).token}` };
}

async function call(method, path, { user, body } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(user && { Cookie: user.cookie }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("json");
  return { status: res.status, body: json && text ? JSON.parse(text) : null, headers: res.headers };
}

const menuByName = async (name, cat) =>
  (await sql("SELECT * FROM menus WHERE name = $1 AND ($2::text IS NULL OR category = $2)", [name, cat ?? null]))[0];
const stockOf = (id) => value("SELECT stock FROM menus WHERE id = $1", [id]);
const cancel = (orderId) => sql("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
const order = (user, items, payMethod = "카드결제") =>
  call("POST", "/api/orders", { user, body: { payMethod, items } });

describe("인증", () => {
  test("로그인하지 않으면 보호된 API 는 401", async () => {
    assert.equal((await call("GET", "/api/me")).body.user, null);
    for (const [m, p] of [
      ["GET", "/api/orders"],
      ["POST", "/api/orders"],
      ["GET", "/api/me/reviewable"],
      ["POST", "/api/orders/1/reorder"],
      ["GET", "/api/favorites"],
      ["PUT", "/api/favorites/1"],
      ["POST", "/api/menus/1/reviews"],
      ["PUT", "/api/reviews/1"],
      ["DELETE", "/api/reviews/1"],
      ["GET", "/api/me/reviews"],
    ]) {
      const r = await call(m, p, { body: m === "GET" ? undefined : {} });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  test("위조/만료 세션 쿠키는 거부", async () => {
    assert.equal((await call("GET", "/api/orders", { user: { cookie: "sid=forged" } })).status, 401);
    const u = await await login("expired");
    await sql("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.id]);
    assert.equal((await call("GET", "/api/orders", { user: u })).status, 401);
  });

  test("로그아웃하면 DB 의 세션이 삭제되어 같은 쿠키로도 접근 불가", async () => {
    const u = await await login("logout-user");
    assert.equal((await call("GET", "/api/me", { user: u })).body.user.id, u.id);
    const r = await call("POST", "/api/auth/logout", { user: u });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie"), /^sid=;/);
    assert.equal((await call("GET", "/api/me", { user: u })).body.user, null);
    assert.equal((await call("GET", "/api/orders", { user: u })).status, 401);
  });

  test("세션 토큰은 해시로만 저장", async () => {
    const u = await await login("hash-user");
    const token = u.cookie.slice(4);
    assert.equal(await value("SELECT COUNT(*) FROM sessions WHERE token_hash = $1", [token]), 0);
    assert.equal(await value("SELECT COUNT(*) FROM sessions WHERE user_id = $1", [u.id]), 1);
  });

  test("같은 공급자 ID 로 재로그인하면 기존 사용자를 재사용", async () => {
    const a = await store.upsertUser({ provider: "kakao", providerUserId: "same", name: "처음" });
    const b = await store.upsertUser({ provider: "kakao", providerUserId: "same", name: "바뀐이름" });
    assert.equal(a.id, b.id);
    assert.equal(b.name, "바뀐이름");
  });

  test("설정되지 않은 공급자 / state 불일치는 로그인 실패로 리다이렉트", async () => {
    let r = await call("GET", "/api/auth/kakao/start");
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /login_error=provider_disabled/);
    process.env.KAKAO_CLIENT_ID = "test-client";
    try {
      r = await call("GET", "/api/auth/kakao/start");
      assert.match(r.headers.get("location"), /^https:\/\/kauth\.kakao\.com\/oauth\/authorize\?/);
      assert.doesNotMatch(r.headers.get("location"), /client_secret/);
      r = await call("GET", "/api/auth/kakao/callback?code=x&state=nope");
      assert.match(r.headers.get("location"), /login_error=invalid_state/);
    } finally {
      delete process.env.KAKAO_CLIENT_ID;
    }
  });

  test("OAuth 콜백: 토큰 교환 → 프로필 조회 → 사용자 저장 → 세션 쿠키 (공급자 응답만 대체)", async () => {
    process.env.KAKAO_CLIENT_ID = "test-client";
    process.env.KAKAO_CLIENT_SECRET = "server-only-secret";
    const realFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(base)) return realFetch(url, opts);
      seen.push(u);
      if (u.startsWith("https://kauth.kakao.com/oauth/token")) {
        assert.match(String(opts.body), /client_secret=server-only-secret/);
        return Response.json({ access_token: "provider-token" });
      }
      if (u.startsWith("https://kapi.kakao.com/v2/user/me")) {
        assert.equal(opts.headers.Authorization, "Bearer provider-token");
        return Response.json({ id: 98765, kakao_account: { profile: { nickname: "카카오유저" } } });
      }
      throw new Error("unexpected " + u);
    };
    try {
      const start = await call("GET", "/api/auth/kakao/start");
      const stateCookie = start.headers.get("set-cookie").split(";")[0];
      const state = new URL(start.headers.get("location")).searchParams.get("state");
      const res = await realFetch(`${base}/api/auth/kakao/callback?code=abc&state=${state}`, {
        redirect: "manual",
        headers: { Cookie: stateCookie },
      });
      assert.equal(res.headers.get("location"), "/?login=ok");
      const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
      assert.match(sid, /HttpOnly/i);
      const me = await call("GET", "/api/me", { user: { cookie: sid.split(";")[0] } });
      assert.equal(me.body.user.name, "카카오유저");
      assert.equal(JSON.stringify(me.body).includes("provider-token"), false);
      assert.equal(seen.length, 2);
    } finally {
      global.fetch = realFetch;
      delete process.env.KAKAO_CLIENT_ID;
      delete process.env.KAKAO_CLIENT_SECRET;
    }
  });
});

describe("주문 / 재고", () => {
  test("가격은 서버 기준으로 계산하고 재고를 차감, 주문 당시 단가는 이후 가격 변경과 무관", async () => {
    const u = await login("price-user");
    const m = await menuByName("비빔밥");
    const before = await stockOf(m.id);
    const r = await order(u, [{ menuId: m.id, quantity: 2, price: 1 }]);
    assert.equal(r.status, 201);
    assert.equal(r.body.order.totalAmount, m.price * 2);
    assert.equal(await stockOf(m.id), before - 2);
    await sql("UPDATE menus SET price = price + 1000 WHERE id = $1", [m.id]);
    const hist = await call("GET", "/api/orders", { user: u });
    assert.equal(hist.body.orders[0].items[0].unitPrice, m.price);
    assert.equal(hist.body.orders[0].totalAmount, m.price * 2);
    await sql("UPDATE menus SET price = $1 WHERE id = $2", [m.price, m.id]);
  });

  test("재고 부족이면 409, 다른 메뉴 재고나 주문 데이터가 일부만 바뀌지 않음", async () => {
    const u = await login("short-user");
    const a = await menuByName("라면");
    const b = await menuByName("치즈라면");
    await sql("UPDATE menus SET stock = 1 WHERE id = $1", [b.id]);
    const sa = await stockOf(a.id);
    const orders = await value("SELECT COUNT(*) FROM orders");
    const items = await value("SELECT COUNT(*) FROM order_items");
    const r = await order(u, [
      { menuId: a.id, quantity: 2 },
      { menuId: b.id, quantity: 3 },
    ]);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "out_of_stock");
    assert.equal(r.body.shortage[0].menuId, b.id);
    assert.equal(await stockOf(a.id), sa);
    assert.equal(await stockOf(b.id), 1);
    assert.equal(await value("SELECT COUNT(*) FROM orders"), orders);
    assert.equal(await value("SELECT COUNT(*) FROM order_items"), items);
  });

  test("품절 메뉴는 주문 불가", async () => {
    const u = await login("soldout-user");
    const r = await order(u, [{ menuId: (await menuByName("부대햄플러스김치찌개")).id, quantity: 1 }]);
    assert.equal(r.status, 409);
  });

  test("잘못된 주문 입력은 400", async () => {
    const u = await login("bad-input");
    const m = await menuByName("냉면");
    assert.equal((await order(u, [])).status, 400);
    assert.equal((await order(u, [{ menuId: m.id, quantity: 0 }])).status, 400);
    assert.equal((await order(u, [{ menuId: m.id, quantity: 1.5 }])).status, 400);
    assert.equal((await order(u, [{ menuId: m.id, quantity: 1 }], "현금")).status, 400);
    assert.equal((await order(u, [{ menuId: 99999, quantity: 1 }])).status, 404);
  });

  test("주문 취소 기능은 제공하지 않음 (주문과 재고가 그대로 유지)", async () => {
    const u = await login("cancel-user");
    const m = await menuByName("냉면");
    const before = await stockOf(m.id);
    const { body } = await order(u, [{ menuId: m.id, quantity: 4 }]);
    const r = await call("POST", `/api/orders/${body.order.id}/cancel`, { user: u });
    assert.equal(r.status, 404);
    assert.equal(await value("SELECT status FROM orders WHERE id = $1", [body.order.id]), "placed");
    assert.equal(await stockOf(m.id), before - 4);
  });
});

describe("사용자 데이터 분리", () => {
  test("주문내역 / 즐겨찾기 / 리뷰는 본인 것만", async () => {
    const a = await login("sep-a");
    const b = await login("sep-b");
    const m = await menuByName("온국밥");
    const { body } = await order(a, [{ menuId: m.id, quantity: 1 }]);
    await call("PUT", `/api/favorites/${m.id}`, { user: a });
    await call("POST", `/api/menus/${m.id}/reviews`, { user: a, body: { rating: 5, content: "맛있어요" } });

    assert.equal((await call("GET", "/api/orders", { user: b })).body.orders.length, 0);
    assert.equal((await call("GET", "/api/favorites", { user: b })).body.favorites.length, 0);
    assert.equal((await call("GET", "/api/me/reviews", { user: b })).body.reviews.length, 0);
    assert.equal((await call("POST", `/api/orders/${body.order.id}/reorder`, { user: b, body: {} })).status, 404);
    const menus = (await call("GET", "/api/menus", { user: b })).body.menus;
    assert.equal(menus.find((x) => x.id === m.id).favorite, false);

    assert.equal((await call("GET", "/api/orders", { user: a })).body.orders.length, 1);
    assert.equal((await call("GET", "/api/favorites", { user: a })).body.favorites[0].id, m.id);
    const rv = (await call("GET", "/api/me/reviews", { user: a })).body.reviews[0];
    assert.equal((await call("PUT", `/api/reviews/${rv.id}`, { user: b, body: { rating: 1, content: "x" } })).status, 404);
    assert.equal((await call("DELETE", `/api/reviews/${rv.id}`, { user: b })).status, 404);
  });

  test("즐겨찾기 추가/해제는 멱등", async () => {
    const u = await login("fav-user");
    const m = await menuByName("마제소바");
    await call("PUT", `/api/favorites/${m.id}`, { user: u });
    await call("PUT", `/api/favorites/${m.id}`, { user: u });
    assert.equal((await call("GET", "/api/favorites", { user: u })).body.favorites.length, 1);
    await call("DELETE", `/api/favorites/${m.id}`, { user: u });
    assert.equal((await call("GET", "/api/favorites", { user: u })).body.favorites.length, 0);
  });
});

describe("메뉴별 주문 집계", () => {
  // 다른 테스트의 주문도 같은 DB 에 있으므로 전후 차이로 검증
  const snapshot = async () => {
    const { stats } = (await call("GET", "/api/stats/menu-orders")).body;
    const cat = (c) => stats.categories.find((x) => x.category === c) || { orderCount: 0, quantity: 0, menus: [] };
    const menu = (id) => stats.categories.flatMap((c) => c.menus).find((m) => m.id === id) || { orderCount: 0, quantity: 0 };
    return { stats, cat, menu };
  };
  const diff = (a, b) => [b.orderCount - a.orderCount, b.quantity - a.quantity];

  test("전체 / 카테고리별 / 메뉴별로 주문 건수와 수량을 구분, 취소 주문은 제외", async () => {
    const x = await menuByName("떡만두라면");
    const y = await menuByName("해장라면");
    const k = await menuByName("비빔밥");
    const u1 = await login("stat-1");
    const u2 = await login("stat-2");
    const before = await snapshot();
    await order(u1, [{ menuId: x.id, quantity: 3 }]); // 1) 라면 x 3개
    await order(u2, [{ menuId: x.id, quantity: 1 }, { menuId: y.id, quantity: 5 }]); // 2) 라면 x 1 + y 5
    await order(u2, [{ menuId: x.id, quantity: 2 }, { menuId: x.id, quantity: 1 }]); // 3) 같은 메뉴 중복 항목은 한 건으로
    await order(u1, [{ menuId: k.id, quantity: 1 }, { menuId: y.id, quantity: 1 }]); // 4) 한식 + 라면
    const c = await order(u1, [{ menuId: y.id, quantity: 7 }, { menuId: k.id, quantity: 2 }]);
    await cancel(c.body.order.id); // 5) 집계 제외
    const after = await snapshot();

    assert.deepEqual(diff(before.menu(x.id), after.menu(x.id)), [3, 7]);
    assert.deepEqual(diff(before.menu(y.id), after.menu(y.id)), [2, 6]);
    assert.deepEqual(diff(before.menu(k.id), after.menu(k.id)), [1, 1]);
    // 카테고리 건수 = 그 카테고리 메뉴가 들어간 주문 수 (주문 2는 라면 메뉴가 2개여도 1건)
    assert.deepEqual(diff(before.cat("라면"), after.cat("라면")), [4, 13]);
    assert.deepEqual(diff(before.cat("한식"), after.cat("한식")), [1, 1]);
    assert.deepEqual(diff(before.stats.total, after.stats.total), [4, 14]);

    const { categories, total } = after.stats;
    for (let i = 1; i < categories.length; i++)
      assert.ok(categories[i - 1].orderCount >= categories[i].orderCount, "카테고리는 건수 높은 순");
    for (const cat of categories) {
      assert.ok(cat.menus.every((m) => m.category === cat.category));
      for (let i = 1; i < cat.menus.length; i++)
        assert.ok(cat.menus[i - 1].orderCount >= cat.menus[i].orderCount, "메뉴는 건수 높은 순");
      assert.equal(cat.quantity, cat.menus.reduce((s, m) => s + m.quantity, 0));
    }
    assert.equal(total.quantity, categories.reduce((s, c) => s + c.quantity, 0));
  });
});

describe("최근 주문 재주문", () => {
  test("장바구니에 이미 있으면 수량 합산, 재고 초과분은 잘리고 품절은 제외", async () => {
    const u = await login("reorder-user");
    const a = await menuByName("비빔면");
    const b = await menuByName("차돌온면");
    const c = await menuByName("매운차돌온면");
    const { body } = await order(u, [
      { menuId: a.id, quantity: 2 },
      { menuId: b.id, quantity: 3 },
      { menuId: c.id, quantity: 1 },
    ]);
    await sql("UPDATE menus SET stock = 4 WHERE id = $1", [b.id]);
    await sql("UPDATE menus SET stock = 0 WHERE id = $1", [c.id]);
    await sql("UPDATE menus SET price = 9999 WHERE id = $1", [a.id]);

    const r = await call("POST", `/api/orders/${body.order.id}/reorder`, {
      user: u,
      body: { cart: { [a.id]: 1, [b.id]: 2 } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.cart[a.id], 3); // 1 + 2
    assert.equal(r.body.cart[b.id], 4); // 2 + 3 → 재고 4로 제한
    assert.equal(r.body.cart[c.id], undefined); // 품절 제외
    const res = Object.fromEntries(r.body.results.map((x) => [x.menuId, x]));
    assert.equal(res[a.id].status, "added");
    assert.equal(res[a.id].price, 9999); // 현재 가격 기준
    assert.equal(res[b.id].status, "partial");
    assert.equal(res[b.id].added, 2);
    assert.equal(res[c.id].status, "sold_out");
    await sql("UPDATE menus SET stock = 30 WHERE id = ANY($1::int[])", [[b.id, c.id]]);
  });

  test("빈 장바구니에 여러 메뉴를 한 번에 담기", async () => {
    const u = await login("reorder-empty");
    const a = await menuByName("주먹밥 2개");
    const b = await menuByName("½우동");
    const { body } = await order(u, [{ menuId: a.id, quantity: 2 }, { menuId: b.id, quantity: 1 }]);
    const r = await call("POST", `/api/orders/${body.order.id}/reorder`, { user: u, body: {} });
    assert.deepEqual(r.body.cart, { [a.id]: 2, [b.id]: 1 });
  });
});

describe("정렬", () => {
  test("가격 낮은/높은 순", async () => {
    const asc = (await call("GET", "/api/menus?sort=price_asc")).body.menus.map((m) => m.price);
    const desc = (await call("GET", "/api/menus?sort=price_desc")).body.menus.map((m) => m.price);
    assert.deepEqual(asc, [...asc].sort((x, y) => x - y));
    assert.deepEqual(desc, [...desc].sort((x, y) => y - x));
    assert.equal((await call("GET", "/api/menus?sort=drop_table")).status, 400);
  });

  test("별점 높은/낮은 순, 별점 없는 메뉴는 항상 뒤", async () => {
    const hi = await menuByName("고소한카레덮밥");
    const lo = await menuByName("부타동고기덮밥");
    for (const [m, rating, who] of [[hi, 5, "r1"], [hi, 4, "r2"], [lo, 1, "r3"]]) {
      const u = await login(who);
      await order(u, [{ menuId: m.id, quantity: 1 }]);
      await call("POST", `/api/menus/${m.id}/reviews`, { user: u, body: { rating, content: "후기" } });
    }
    for (const sort of ["rating_desc", "rating_asc"]) {
      const list = (await call("GET", `/api/menus?sort=${sort}`)).body.menus;
      const firstNull = list.findIndex((m) => m.ratingAvg === null);
      assert.ok(firstNull > 0);
      assert.ok(list.slice(firstNull).every((m) => m.ratingAvg === null), `${sort}: 별점 없는 메뉴가 뒤에`);
      const rated = list.slice(0, firstNull).map((m) => m.ratingAvg);
      const sorted = [...rated].sort((x, y) => (sort === "rating_desc" ? y - x : x - y));
      assert.deepEqual(rated, sorted);
    }
    const desc = (await call("GET", "/api/menus?sort=rating_desc")).body.menus;
    assert.ok(desc.findIndex((m) => m.id === hi.id) < desc.findIndex((m) => m.id === lo.id));
  });
});

describe("리뷰", () => {
  test("주문하지 않은 메뉴는 리뷰 불가 (취소한 주문만 있어도 불가)", async () => {
    const u = await login("rv-noorder");
    const m = await menuByName("세곱배기생우동");
    let r = await call("POST", `/api/menus/${m.id}/reviews`, { user: u, body: { rating: 5, content: "좋아요" } });
    assert.equal(r.status, 403);
    const { body } = await order(u, [{ menuId: m.id, quantity: 1 }]);
    await cancel(body.order.id);
    r = await call("POST", `/api/menus/${m.id}/reviews`, { user: u, body: { rating: 5, content: "좋아요" } });
    assert.equal(r.status, 403);
  });

  test("중복 작성 방지, 수정/삭제, 평균 별점과 개수 자동 갱신, 최신순", async () => {
    const m = await menuByName("치킨가라아게마요");
    const a = await login("rv-a");
    const b = await login("rv-b");
    await order(a, [{ menuId: m.id, quantity: 1 }]);
    await order(b, [{ menuId: m.id, quantity: 1 }]);

    const ra = await call("POST", `/api/menus/${m.id}/reviews`, { user: a, body: { rating: 2, content: "먼저 씀" } });
    assert.equal(ra.status, 201);
    const dup = await call("POST", `/api/menus/${m.id}/reviews`, { user: a, body: { rating: 5, content: "또 씀" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "duplicate_review");
    await call("POST", `/api/menus/${m.id}/reviews`, { user: b, body: { rating: 5, content: "나중에 씀" } });

    let res = await call("GET", `/api/menus/${m.id}/reviews`, { user: a });
    assert.equal(res.body.menu.reviewCount, 2);
    assert.equal(res.body.menu.ratingAvg, 3.5);
    assert.equal(res.body.reviews[0].content, "나중에 씀"); // 최신순
    assert.equal(res.body.me.review.id, ra.body.review.id);

    assert.equal(
      (await call("PUT", `/api/reviews/${ra.body.review.id}`, { user: a, body: { rating: 4, content: "수정함" } })).status,
      200,
    );
    res = await call("GET", `/api/menus/${m.id}/reviews`);
    assert.equal(res.body.menu.ratingAvg, 4.5);
    assert.equal(res.body.me, null);

    assert.equal((await call("DELETE", `/api/reviews/${ra.body.review.id}`, { user: a })).status, 204);
    res = await call("GET", `/api/menus/${m.id}/reviews`);
    assert.equal(res.body.menu.reviewCount, 1);
    assert.equal(res.body.menu.ratingAvg, 5);
    // 삭제 후에는 다시 작성 가능
    assert.equal(
      (await call("POST", `/api/menus/${m.id}/reviews`, { user: a, body: { rating: 3, content: "다시" } })).status,
      201,
    );
  });

  test("별점/내용 검증", async () => {
    const u = await login("rv-valid");
    const m = await menuByName("가스오부시생우동");
    await order(u, [{ menuId: m.id, quantity: 1 }]);
    for (const body of [{ rating: 0, content: "a" }, { rating: 6, content: "a" }, { rating: 3, content: "  " }, { rating: 3, content: "가".repeat(501) }])
      assert.equal((await call("POST", `/api/menus/${m.id}/reviews`, { user: u, body })).status, 400);
  });
});

describe("리뷰 쓰기 목록", () => {
  test("내가 주문한 메뉴만, 아직 안 쓴 메뉴가 먼저, 다른 사용자와 분리", async () => {
    const u = await login("writer");
    const other = await login("writer-other");
    const a = await menuByName("부대라면");
    const b = await menuByName("마라맛");
    const c = await menuByName("주먹밥 2개");
    await order(u, [{ menuId: a.id, quantity: 1 }, { menuId: b.id, quantity: 1 }]);
    await order(u, [{ menuId: a.id, quantity: 2 }]);
    const x = await order(u, [{ menuId: c.id, quantity: 1 }]);
    await cancel(x.body.order.id);
    await call("POST", `/api/menus/${a.id}/reviews`, { user: u, body: { rating: 4, content: "좋아요" } });

    const list = (await call("GET", "/api/me/reviewable", { user: u })).body.menus;
    assert.deepEqual(list.map((m) => m.id), [b.id, a.id]); // 취소된 주문의 메뉴(c)는 없음, 미작성(b) 먼저
    assert.equal(list[1].orderCount, 2);
    assert.equal(list[1].rating, 4);
    assert.equal(list[0].reviewId, null);
    assert.equal((await call("GET", "/api/me/reviewable", { user: other })).body.menus.length, 0);
  });
});

describe("식품 정보", () => {
  test("메뉴별 알레르기, 카테고리별 원산지가 food-info.js 와 일치", async () => {
    const { MENU_ALLERGENS, ALLERGENS, ALLERGENS_VERIFIED, ORIGINS } = require("../server/food-info");
    const r = await call("GET", "/api/food-info");
    assert.equal(r.status, 200);
    assert.equal(r.body.allergensVerified, ALLERGENS_VERIFIED);
    assert.deepEqual(r.body.allergens, ALLERGENS);
    assert.equal(r.body.menus.length, await value("SELECT COUNT(*) FROM menus"));
    for (const m of r.body.menus) {
      const a = MENU_ALLERGENS[`${m.category}/${m.name}`];
      assert.ok(a, `${m.category}/${m.name} 정보 없음`);
      assert.deepEqual([...m.allergens].sort(), [...a].sort());
    }
    const cats = [...new Set(r.body.menus.map((m) => m.category))];
    for (const c of cats)
      assert.deepEqual(
        r.body.origins[c].map((o) => [o.ingredient, o.origin]),
        ORIGINS[c],
        `${c} 원산지`,
      );
    assert.equal(r.body.origins["한식"].find((o) => o.ingredient === "배추김치").origin, "배추(중국산)");
    assert.equal(r.body.origins["라면"].find((o) => o.ingredient === "배추김치").origin, "배추(국내산)");
  });
});

describe("데이터 무결성", () => {
  test("외래 키 · CHECK 제약이 동작", async () => {
    await assert.rejects(
      sql("INSERT INTO order_items (order_id, menu_id, quantity, unit_price) VALUES (999999, 1, 1, 100)"),
      (e) => e.code === "23503", // foreign_key_violation
    );
    await assert.rejects(sql("UPDATE menus SET stock = -1 WHERE id = (SELECT MIN(id) FROM menus)"), (e) => e.code === "23514");
  });

  test("동시에 같은 메뉴를 주문해도 재고 이상으로 팔리지 않음 (행 잠금)", async () => {
    const m = await menuByName("마라맛");
    await sql("UPDATE menus SET stock = 5 WHERE id = $1", [m.id]);
    const users = await Promise.all([...Array(8)].map((_, i) => login(`race-${i}`)));
    const results = await Promise.all(users.map((u) => order(u, [{ menuId: m.id, quantity: 1 }])));
    assert.equal(results.filter((r) => r.status === 201).length, 5);
    assert.equal(results.filter((r) => r.status === 409).length, 3);
    assert.equal(await stockOf(m.id), 0);
    await sql("UPDATE menus SET stock = 30 WHERE id = $1", [m.id]);
  });
});

describe("혼잡도", () => {
  test("오늘 앱 주문 1건당 1%, 취소 제외, 100%에서 멈춤, 어제 주문은 제외", async () => {
    const u = await login("crowd-user");
    const m = await menuByName("공기밥", "중식");
    const before = (await call("GET", "/api/crowd")).body;
    assert.equal(before.max, 100);
    await order(u, [{ menuId: m.id, quantity: 1 }]);
    await order(u, [{ menuId: m.id, quantity: 3 }]); // 수량이 아니라 주문 건수로 계산
    const x = await order(u, [{ menuId: m.id, quantity: 1 }]);
    await cancel(x.body.order.id);
    const y = await order(u, [{ menuId: m.id, quantity: 1 }]);
    await sql("UPDATE orders SET ordered_at = now() - interval '2 days' WHERE id = $1", [y.body.order.id]);
    let after = (await call("GET", "/api/crowd")).body;
    assert.equal(after.appOrders - before.appOrders, 2);
    assert.equal(after.percent, Math.min(100, after.appOrders));
    assert.equal(after.hourly.reduce((s, h) => s + h.count, 0), after.appOrders);

    // 100건을 넘어도 100%
    await sql(
      "INSERT INTO orders (user_id, total_amount, pay_method, ticket_no) SELECT $1, 0, '카드결제', 100 FROM generate_series(1, 120)",
      [u.id],
    );
    after = (await call("GET", "/api/crowd")).body;
    assert.ok(after.appOrders > 100);
    assert.equal(after.percent, 100);
  });
});
