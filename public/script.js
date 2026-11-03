const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const won = (n) => n.toLocaleString("ko-KR") + "원";
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const img = (m) =>
  /^(https?:)?\//.test(m.image)
    ? `<img src="${esc(m.image)}" alt="" />`
    : esc(m.image);
const day = (s) => {
  const d = new Date(s.replace(" ", "T") + "Z"),
    p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
};
const time = (s) => {
  const d = new Date(s.replace(" ", "T") + "Z");
  return `${day(s)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const stars = (n) =>
  `<span class="stars" aria-label="5점 만점에 ${n}점">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>`;

const PAY = ["카드결제", "카카오페이", "네이버페이", "토스페이"];
const FAV = "즐겨찾기";
const PROTECTED = [
  "home",
  "menu",
  "cart",
  "pay",
  "done",
  "history",
  "stats",
  "me",
  "write",
  "food",
];
const PROVIDER_LABEL = {
  kakao: "카카오톡",
  naver: "네이버",
  google: "구글",
};
// 혼잡도 단계 (신호등 색: 여유=초록, 보통=주황, 혼잡=빨강)
const LEVELS = [
  { min: 70, key: "high", label: "혼잡", tip: "주문하고 받으러 가세요" },
  { min: 30, key: "mid", label: "보통", tip: "조금 기다릴 수 있어요" },
  { min: 0, key: "low", label: "여유", tip: "지금 가면 바로 받을 수 있어요" },
];
const level = (p) => LEVELS.find((l) => p >= l.min);

let user = null,
  providers = [],
  booted,
  menus = null,
  menusErr = "",
  sort = "default",
  orders = null,
  ordersErr = "",
  stats = null,
  statsErr = "",
  myReviews = null,
  myReviewsErr = "",
  reviewable = null,
  reviewableErr = "",
  food = null,
  foodErr = "",
  foodTab = "",
  crowd = null,
  appVersion = "v 0.1.0-proto",
  busy = false;
let cart = {},
  tab = "한식",
  pay = 0,
  cur = "splash",
  trail = [];

/* ---------- API ---------- */

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("네트워크 연결을 확인해주세요."), {
      status: 0,
    });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && user) signedOut("로그인이 필요해요");
  if (!res.ok)
    throw Object.assign(new Error(data?.message || "요청에 실패했어요."), {
      status: res.status,
      data,
    });
  return data;
}

/* ---------- 장바구니 (사용자별로 브라우저에 보관, 가격/재고는 서버 메뉴 기준) ---------- */

const cartKey = () => user && `cart:${user.id}`;
function saveCart() {
  try {
    if (user) localStorage.setItem(cartKey(), JSON.stringify(cart));
  } catch {}
}
function loadCart() {
  try {
    cart = JSON.parse(localStorage.getItem(cartKey())) || {};
  } catch {
    cart = {};
  }
}
// 메뉴 정보가 바뀌면 없는 메뉴는 빼고 재고를 넘는 수량은 줄인다
function fitCart() {
  if (!menus) return [];
  const changed = [];
  for (const id of Object.keys(cart)) {
    const m = get(id);
    const q = Math.min(cart[id], m ? m.stock : 0);
    if (q !== cart[id]) changed.push(m?.name || "삭제된 메뉴");
    if (q > 0) cart[id] = q;
    else delete cart[id];
  }
  return changed;
}
const get = (id) => menus?.find((i) => i.id === +id);
const lines = () =>
  Object.entries(cart)
    .filter(([id, q]) => q > 0 && get(id))
    .map(([id, q]) => ({ ...get(id), q }));
const total = () => lines().reduce((s, l) => s + l.price * l.q, 0);
const count = () => lines().reduce((s, l) => s + l.q, 0);

/* ---------- 데이터 로딩 ---------- */

async function loadMenus(quiet) {
  try {
    menus = (await api("/menus?sort=" + sort)).menus;
    menusErr = "";
    const cut = fitCart();
    if (cut.length && !quiet)
      toast(`재고가 바뀌어 장바구니를 조정했어요: ${cut.join(", ")}`);
  } catch (e) {
    menusErr = e.message;
  }
  render();
}
async function loadOrders() {
  try {
    orders = (await api("/orders")).orders;
    ordersErr = "";
  } catch (e) {
    ordersErr = e.message;
  }
  render();
}
async function loadStats() {
  try {
    stats = (await api("/stats/menu-orders")).stats;
    statsErr = "";
  } catch (e) {
    statsErr = e.message;
  }
  render();
}
async function loadReviewable() {
  try {
    reviewable = (await api("/me/reviewable")).menus;
    reviewableErr = "";
  } catch (e) {
    reviewableErr = e.message;
  }
  render();
}
async function loadFood() {
  try {
    food = await api("/food-info");
    foodErr = "";
  } catch (e) {
    foodErr = e.message;
  }
  render();
}
async function loadCrowd() {
  try {
    crowd = await api("/crowd");
  } catch {} // 실패하면 직전 값을 그대로 보여준다
  renderCrowd();
}
async function loadMyReviews() {
  try {
    myReviews = (await api("/me/reviews")).reviews;
    myReviewsErr = "";
  } catch (e) {
    myReviewsErr = e.message;
  }
  render();
}

/* ---------- 인증 ---------- */

function signedIn(u) {
  user = u;
  loadCart();
  menus = orders = stats = myReviews = reviewable = null;
  loadMenus();
}
function signedOut(msg) {
  user = null;
  cart = {};
  menus = orders = stats = myReviews = reviewable = null;
  closeRv();
  trail = [];
  if (PROTECTED.includes(cur)) go("login", true);
  if (msg) toast(msg);
}
async function boot() {
  const q = new URLSearchParams(location.search);
  const err = q.get("login_error");
  if (q.has("login") || err) history.replaceState(null, "", location.pathname);
  const [me, pv] = await Promise.allSettled([
    api("/me"),
    api("/auth/providers"),
  ]);
  providers = pv.value?.providers || [];
  if (me.value?.user) signedIn(me.value.user);
  if (err)
    toast(
      {
        denied: "로그인이 취소되었어요",
        invalid_state: "로그인 요청이 만료되었어요. 다시 시도해주세요",
        provider_disabled: "아직 연결되지 않은 로그인 방식이에요",
      }[err] || "로그인에 실패했어요. 다시 시도해주세요",
    );
  if (user && q.get("login") === "ok") go("home");
  else if (err) go("login");
  render();
}

/* ---------- 화면 ---------- */

function go(id, back) {
  if (PROTECTED.includes(id) && !user) {
    if (cur !== "login") toast("로그인이 필요해요");
    id = "login";
  }
  if (!back && cur !== id) trail.push(cur);
  $("#" + cur).classList.remove("on");
  cur = id;
  $("#" + id).classList.add("on");
  if (id === "menu" || id === "home") loadMenus();
  if (id === "home" || id === "crowd") loadCrowd();
  if (id === "history") loadOrders();
  if (id === "stats") loadStats();
  if (id === "me") {
    loadMyReviews();
    if (!appVersion)
      api("/app-info")
        .then((r) => ((appVersion = r.version), renderMe()))
        .catch(() => {});
  }
  if (id === "write") loadReviewable();
  if (id === "food" && !food) loadFood();
  render();
}
function toast(t) {
  const e = $("#toast");
  e.textContent = t;
  e.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => e.classList.remove("on"), 2600);
}
const state = (msg, retry) =>
  `<div class="empty">${msg}${retry ? `<br><button class="add retry" data-retry="${retry}">다시 시도</button>` : ""}</div>`;
const loading = () => state("불러오는 중…");

const icoHome =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg>';
const icoTix =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z"/></svg>';
const icoMore =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
const icoHeart =
  '<svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.4 3.8 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.4 0 5.7 3.4 4.5 6.8C19.5 15.4 12 20 12 20z"/></svg>';
function nav() {
  $$("[data-nav]").forEach((n) => {
    const s = n.closest(".scr").id;
    n.innerHTML = `<button class="${s === "home" ? "on" : ""}" data-go="home">${icoHome}홈</button><button class="${s === "history" ? "on" : ""}" data-go="history">${icoTix}주문내역</button><button class="${s === "crowd" ? "on" : ""}" data-go="crowd">${icoMore}혼잡도</button>`;
  });
}
function ctrl(id, q) {
  const max = q >= (get(id)?.stock ?? 0);
  return `<div class="qty"><button data-d="-1" data-id="${id}" aria-label="수량 줄이기">${q === 1 ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' : "−"}</button><span>${q}</span><button data-d="1" data-id="${id}" aria-label="수량 늘리기" class="${max ? "max" : ""}">+</button></div>`;
}
function rating(m) {
  return m.reviewCount
    ? `<span class="star">★</span> ${m.ratingAvg.toFixed(1)} <em>리뷰 ${m.reviewCount}</em>`
    : `<em>아직 리뷰 없음</em>`;
}

function renderMenu() {
  const cats = menus ? [...new Set(menus.map((m) => m.category))] : [];
  if (menus && tab !== FAV && !cats.includes(tab)) tab = cats[0];
  $("#tabs").innerHTML = [FAV, ...cats]
    .map(
      (t) =>
        `<button role="tab" aria-selected="${t === tab}" class="${t === tab ? "on" : ""}" data-tab="${t}">${t === FAV ? "♥ " + t : t}</button>`,
    )
    .join("");
  $("#sort").value = sort;
  if (!menus) {
    $("#list").innerHTML = menusErr ? state(esc(menusErr), "menus") : loading();
    return;
  }
  const list = menus.filter((m) =>
    tab === FAV ? m.favorite : m.category === tab,
  );
  $("#list").innerHTML = list.length
    ? list
        .map((i) => {
          const q = cart[i.id] || 0,
            out = i.stock <= 0;
          return `<div class="item ${out ? "out" : ""}"><div class="ph"><span aria-hidden="true">${img(i)}</span><button class="fav ${i.favorite ? "on" : ""}" data-fav="${i.id}" aria-pressed="${!!i.favorite}" aria-label="${esc(i.name)} 즐겨찾기">${icoHeart}</button></div><button class="info" data-rv="${i.id}" aria-label="${esc(i.name)} 리뷰 보기"><h3>${esc(i.name)}</h3><div class="pr">${won(i.price)}</div><div class="meta">${rating(i)}${!out && i.stock <= 5 ? `<em class="low">${i.stock}개 남음</em>` : ""}</div></button>${out ? '<span class="out-b">품절</span>' : q ? ctrl(i.id, q) : `<button class="add" data-d="1" data-id="${i.id}" aria-label="${esc(i.name)} 담기">+ 담기</button>`}</div>`;
        })
        .join("")
    : tab === FAV
      ? state(
          "아직 즐겨찾기한 메뉴가 없어요.<br>메뉴 사진의 ♥ 를 눌러 모아보세요.",
        )
      : state("이 코너에는 메뉴가 없어요.");
}

function renderOrders() {
  if (!orders) {
    $("#hist").innerHTML = ordersErr
      ? state(esc(ordersErr), "history")
      : loading();
    return;
  }
  const latestId = orders.find((o) => o.status !== "cancelled")?.id;
  $("#hist").innerHTML = orders.length
    ? `<p class="lab">최근 주문</p>` +
      orders
        .map((o) => {
          // '현재' = 가장 최근에 주문한 교환권 하나. 그 이전 교환권은 사용한 것으로 보고 회색 처리
          const now = o.id === latestId;
          const used = !now && o.status !== "cancelled";
          const chip = now
            ? '<span class="chip">현재</span>'
            : used
              ? '<span class="chip done">사용 완료</span>'
              : '<span class="chip bad">취소됨</span>';
          return `<article class="oc ${now ? "new" : ""} ${used ? "used" : ""} ${o.status === "cancelled" ? "off" : ""}" ${now ? `data-ticket="${o.id}" role="button" tabindex="0" aria-label="교환권 ${o.ticketNo}번 주문 완료 화면 보기"` : ""}><header><b>${day(o.orderedAt)}${chip}</b><span>${esc(o.payMethod)} · 교환권 ${o.ticketNo}</span></header>${o.items.map((l) => `<div class="l"><b>${esc(l.name)} × ${l.quantity}</b><span>${won(l.unitPrice * l.quantity)}</span></div>`).join("")}<footer><span>합계</span><b>${won(o.totalAmount)}</b></footer><div class="acts">${now ? '<span class="hint">눌러서 교환권 보기 ›</span>' : ""}<button class="add" data-reorder="${o.id}">${o.items.length > 1 ? "전체 다시 담기" : "다시 담기"}</button></div></article>`;
        })
        .join("")
    : state("아직 주문 내역이 없어요.<br>메뉴를 골라 첫 주문을 해보세요.");
}

function renderCrowd() {
  if (!crowd) return;
  const p = crowd.percent,
    lv = level(p);
  // 홈 카드
  const live = $("#live");
  live.className = `live lv-${lv.key}`;
  live.setAttribute(
    "aria-label",
    `지금 혼잡도 ${p}%, ${lv.label}. 자세히 보기`,
  );
  $("#liveN").textContent = p;
  $("#liveS").textContent = lv.label;
  $("#liveT").textContent = lv.tip;
  // 원 외곽선이 혼잡도만큼 채워짐 (0%면 표시하지 않음)
  const ring = $("#liveRing");
  ring.setAttribute("stroke-dasharray", `${p} 100`);
  ring.style.opacity = p ? 1 : 0;
  // 혼잡도 화면
  $("#gArc").setAttribute("stroke-dasharray", `${p} 100`);
  $("#gN").textContent = `${p}%`;
  $("#gS").textContent = lv.label;
  $("#gS").className = `lv-${lv.key}`;
  $("#appOrders").textContent = crowd.appOrders;
  // 그래프: 오늘 시간대별 누적 주문 수 = 그 시각의 혼잡도
  const first = crowd.hourly[0]?.hour ?? crowd.hourNow;
  const start = Math.min(11, first, crowd.hourNow);
  const by = Object.fromEntries(crowd.hourly.map((h) => [h.hour, h.count]));
  let cum = 0;
  const pts = [];
  for (let h = start; h <= crowd.hourNow; h++) {
    cum += by[h] || 0;
    pts.push(Math.min(100, Math.round((cum / crowd.max) * 100)));
  }
  if (pts.length === 1) pts.unshift(pts[0]);
  const xy = pts.map((v, i) => [8 + (i * 284) / (pts.length - 1), 120 - v]);
  const line = "M" + xy.map(([x, y]) => `${x.toFixed(1)} ${y}`).join(" ");
  $("#gLine").setAttribute("d", line);
  $("#gArea").setAttribute("d", `${line}V120H8z`);
  const [lx, ly] = xy[xy.length - 1];
  $("#gDot").setAttribute("cx", lx.toFixed(1));
  $("#gDot").setAttribute("cy", ly);
  $("#gStart").textContent = `${start}시`;
  $("#graph").setAttribute(
    "aria-label",
    `${start}시부터 현재까지 혼잡도, 지금 ${p}%`,
  );
}

function renderStats() {
  if (!stats) {
    $("#statList").innerHTML = statsErr
      ? state(esc(statsErr), "stats")
      : loading();
    return;
  }
  const { total, categories } = stats;
  const pct = (n) => Math.round((n / (total.orderCount || 1)) * 100);
  $("#statList").innerHTML = total.orderCount
    ? `<div class="card sumc"><h2>전체 주문</h2><div class="stats"><div><span>주문 건수</span><b>${total.orderCount}건</b></div><div><span>주문 수량</span><b>${total.quantity}개</b></div><div><span>카테고리</span><b>${categories.length}</b></div></div></div>` +
      categories
        .map((c) => {
          const max = c.menus[0]?.orderCount || 1;
          return `<section class="card cat"><header><h2>${esc(c.category)}</h2><div class="num"><b>${c.orderCount}건</b><span>수량 ${c.quantity}개</span></div></header><div class="bar"><i style="width:${Math.max(3, pct(c.orderCount))}%"></i></div><small class="share">전체 주문의 ${pct(c.orderCount)}%</small><ol class="rank">${c.menus
            .map(
              (m, i) =>
                `<li class="item"><span class="no">${i + 1}</span><div class="ph" aria-hidden="true">${img(m)}</div><div class="info"><h3>${esc(m.name)}</h3><div class="bar"><i style="width:${Math.max(4, (m.orderCount / max) * 100)}%"></i></div></div><div class="num"><b>${m.orderCount}건</b><span>수량 ${m.quantity}개</span></div></li>`,
            )
            .join("")}</ol></section>`;
        })
        .join("")
    : state("아직 집계할 주문이 없어요.");
}

function renderWrite() {
  if (!reviewable) {
    $("#writeList").innerHTML = reviewableErr
      ? state(esc(reviewableErr), "write")
      : loading();
    return;
  }
  const row = (m) =>
    `<div class="item"><div class="ph" aria-hidden="true">${img(m)}</div><div class="info"><h3>${esc(m.name)}</h3>${m.reviewId ? stars(m.rating) : `<small>최근 주문 ${day(m.lastOrderedAt)} · ${m.orderCount}회 주문</small>`}</div>${m.reviewId ? `<button class="add" data-rv="${m.id}" data-rvmode="edit">수정</button>` : `<button class="add pri" data-rv="${m.id}">리뷰 쓰기</button>`}</div>`;
  const todo = reviewable.filter((m) => !m.reviewId),
    done = reviewable.filter((m) => m.reviewId);
  $("#writeList").innerHTML = reviewable.length
    ? `<p class="note top">주문했던 메뉴에만 리뷰를 남길 수 있어요.</p>` +
      (todo.length
        ? `<p class="lab">리뷰를 기다리는 메뉴 ${todo.length}</p>${todo.map(row).join("")}`
        : "") +
      (done.length
        ? `<p class="lab">작성한 리뷰 ${done.length}</p>${done.map(row).join("")}`
        : "")
    : `<div class="empty">아직 주문한 메뉴가 없어요.<br>주문한 메뉴에만 리뷰를 남길 수 있어요.<br><button class="add retry" data-go="menu">메뉴 보러 가기</button></div>`;
}

function renderFood() {
  if (!food) {
    $("#foodTabs").innerHTML = "";
    $("#foodList").innerHTML = foodErr
      ? state(esc(foodErr), "food")
      : loading();
    return;
  }
  const cats = [...new Set(food.menus.map((m) => m.category))];
  if (!cats.includes(foodTab)) foodTab = cats[0];
  $("#foodTabs").innerHTML = cats
    .map(
      (t) =>
        `<button role="tab" aria-selected="${t === foodTab}" class="${t === foodTab ? "on" : ""}" data-foodtab="${t}">${t}</button>`,
    )
    .join("");
  const origins = food.origins[foodTab] || [];
  $("#foodList").innerHTML =
    `<section class="card ocard"><h2>${esc(foodTab)} 코너 원산지</h2>${
      origins.length
        ? `<dl>${origins.map((o) => `<dt>${esc(o.ingredient)}</dt><dd>${esc(o.origin)}</dd>`).join("")}</dl>`
        : '<p class="note">원산지 정보가 아직 없어요.</p>'
    }</section>` +
    `<p class="lab">메뉴별 알레르기 유발물질</p>` +
    (food.allergensVerified
      ? ""
      : `<div class="notice" role="note"><b>알레르기 정보는 확인 전이에요</b>식당에서 확인하기 전의 초안이라 빠진 성분이 있을 수 있어요. 알레르기가 있다면 주문 전에 식당에 꼭 확인해주세요.</div>`) +
    food.menus
      .filter((m) => m.category === foodTab)
      .map(
        (m) =>
          `<article class="fi"><div class="ph" aria-hidden="true">${img(m)}</div><div><h3>${esc(m.name)}</h3><div class="algs">${m.allergens.length ? m.allergens.map((a) => `<span class="alg">${esc(a)}</span>`).join("") : `<em>${food.allergensVerified ? "표시 대상 없음" : "확인 중"}</em>`}</div></div></article>`,
      )
      .join("") +
    `<p class="note">알레르기 유발물질 표시 대상: ${food.allergens.map(esc).join(", ")}</p>`;
}

function renderMe() {
  if (!user) return;
  const rv = !myReviews
    ? myReviewsErr
      ? state(esc(myReviewsErr), "me")
      : loading()
    : myReviews.length
      ? myReviews
          .map(
            (r) =>
              `<button class="rvi" data-rv="${r.menuId}"><div class="ph" aria-hidden="true">${img({ image: r.menuImage })}</div><div><b>${esc(r.menuName)}</b>${stars(r.rating)}<p>${esc(r.content)}</p><small>${day(r.createdAt)}${r.updatedAt !== r.createdAt ? " · 수정됨" : ""}</small></div></button>`,
          )
          .join("")
      : state("아직 작성한 리뷰가 없어요.<br>주문한 메뉴에 별점을 남겨보세요.");
  $("#meBody").innerHTML =
    `<p class="lab">내 정보</p><div class="card me"><div class="av" aria-hidden="true">${user.profileImage ? `<img src="${esc(user.profileImage)}" alt="" />` : esc(user.name[0])}</div><div><b>${esc(user.name)}</b><span>${PROVIDER_LABEL[user.provider] || esc(user.provider)} 로그인${user.email ? " · " + esc(user.email) : ""}</span></div></div>` +
    `<p class="lab">앱 정보</p><section class="card ocard appi"><header><img src="mascot.png" alt="" /><div><b>학식먹자</b><span>줄 서기 전에, 먼저 주문하세요</span></div></header><dl><dt>버전</dt><dd>${appVersion ? esc(appVersion) : "확인 중"}</dd><dt>이용 식당</dt><dd>1학 학생식당</dd><dt>주요 기능</dt><dd>사전 주문 · 실시간 혼잡도 · 리뷰 · 식품 정보</dd></dl></section>` +
    `<p class="lab">내가 쓴 리뷰</p>${rv}`;
}

function render() {
  if (user) {
    // 긴 이름은 말줄임(…)으로 줄이고 '님'은 항상 보이게
    const n = $("#userName");
    n.innerHTML = `<span class="nm">${esc(user.name)}</span><span>님</span>`;
    n.title = `${user.name} 님`;
  }
  $$("[data-login]").forEach((b) =>
    b.classList.toggle("off", !providers.includes(b.dataset.login)),
  );
  renderMenu();
  const c = count();
  $("#fab").classList.toggle("hide", !c);
  $("#bdg").textContent = c;
  const ob = $("#orderBtn");
  ob.disabled = !c;
  ob.textContent = c ? `${won(total())} 주문하기` : "메뉴를 담아주세요";
  $("#shList").innerHTML =
    lines()
      .map(
        (l) =>
          `<div class="mini"><span>${esc(l.name)}</span><span>× ${l.q}</span></div>`,
      )
      .join("") || '<div class="empty">담은 메뉴가 없어요</div>';
  const ls = lines(),
    g = {};
  ls.forEach((l) => (g[l.category] ??= []).push(l));
  $("#cartList").innerHTML = ls.length
    ? Object.entries(g)
        .map(
          ([k, a]) =>
            `<div class="grp"><h2>${esc(k)} 코너</h2>${a.map((l) => `<div class="ci"><div class="ph" aria-hidden="true">${img(l)}</div><div class="m"><h3>${esc(l.name)}</h3><p>단가 ${won(l.price)}${l.stock <= 5 ? ` · 재고 ${l.stock}개` : ""}</p><div class="b">${ctrl(l.id, l.q)}<b>${won(l.price * l.q)}</b></div></div></div>`).join("")}</div>`,
        )
        .join("") +
      `<div class="sum"><span>총 메뉴 수</span><b>${c}개</b></div>`
    : '<div class="empty">장바구니가 비어 있어요.<br>메뉴를 골라 담아보세요.</div>';
  $("#cartTotal").textContent = $("#payTotal").textContent = won(total());
  $("#toPay").disabled = !c;
  $("#payOpts").innerHTML = PAY.map(
    (p, i) =>
      `<button class="opt" role="radio" aria-checked="${i === pay}" data-pay="${i}"><i></i>${p}</button>`,
  ).join("");
  const pb = $("#placeBtn");
  pb.disabled = busy || !c;
  pb.textContent = busy ? "주문하는 중…" : "주문하기";
  renderOrders();
  renderStats();
  renderWrite();
  renderFood();
  renderMe();
  saveCart();
  nav();
}

/* ---------- 리뷰 시트 ---------- */

let rv = null; // { menuId, data, err, editing, draft: {rating, content}, confirmDel, saving }

async function openRv(menuId, mode) {
  rv = { menuId: +menuId, mode, draft: { rating: 0, content: "" } };
  $("#rvSheet").classList.add("on");
  $("#rvDim").classList.add("on");
  renderRv();
  await loadRv();
}
async function loadRv() {
  const id = rv.menuId;
  try {
    const data = await api(`/menus/${id}/reviews`);
    if (rv?.menuId !== id) return;
    rv.data = data;
    rv.err = "";
    const mine = data.me?.review;
    if (rv.mode === "edit" && mine) {
      rv.mode = "";
      Object.assign(rv, {
        editing: true,
        draft: { rating: mine.rating, content: mine.content },
      });
    }
    // 메뉴 목록의 평균 별점/리뷰 수도 최신 값으로
    const m = get(id);
    if (m)
      Object.assign(m, {
        ratingAvg: data.menu.ratingAvg,
        reviewCount: data.menu.reviewCount,
      });
  } catch (e) {
    if (rv) rv.err = e.message;
  }
  renderRv();
  render();
}
function closeRv() {
  rv = null;
  $("#rvSheet").classList.remove("on");
  $("#rvDim").classList.remove("on");
}
function rvForm() {
  const d = rv.draft;
  return `<form class="rvf" id="rvForm"><div class="pick" role="radiogroup" aria-label="별점">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${d.rating === n}" aria-label="${n}점" class="${n <= d.rating ? "on" : ""}" data-star="${n}">★</button>`).join("")}</div><textarea id="rvText" maxlength="500" rows="3" placeholder="맛, 양, 온도는 어땠나요?">${esc(d.content)}</textarea><div class="rvf-b"><small id="rvCnt">${d.content.length}/500</small>${rv.editing ? '<button type="button" class="add" data-rvcancel>취소</button>' : ""}<button class="add pri" ${rv.saving ? "disabled" : ""}>${rv.saving ? "저장 중…" : rv.editing ? "수정 완료" : "리뷰 등록"}</button></div></form>`;
}
function rvCard(r, mine) {
  return `<article class="rvc ${mine ? "mine" : ""}"><header><b><span class="nm">${esc(r.userName)}</span>${mine ? '<span class="chip">내 리뷰</span>' : ""}</b><small>${day(r.createdAt)}${r.updatedAt !== r.createdAt ? " · 수정됨" : ""}</small></header>${stars(r.rating)}<p>${esc(r.content)}</p>${mine ? `<div class="acts"><button class="add" data-rvedit>수정</button><button class="add ${rv.confirmDel ? "warn" : ""}" data-rvdel>${rv.confirmDel ? "한 번 더 누르면 삭제돼요" : "삭제"}</button></div>` : ""}</article>`;
}
function renderRv() {
  if (!rv) return;
  const head = (t) =>
    `<div class="grab"></div><div class="sh-h"><b>${t}</b><button class="ib" data-rvclose aria-label="닫기"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>`;
  if (!rv.data) {
    $("#rvSheet").innerHTML =
      head(esc(get(rv.menuId)?.name || "리뷰")) +
      (rv.err ? state(esc(rv.err), "rv") : loading());
    return;
  }
  const { menu, reviews, me } = rv.data;
  const mine = me?.review;
  let my = "";
  if (mine && !rv.editing) my = rvCard(mine, true);
  else if (mine || me?.ordered) my = rvForm();
  else my = `<p class="note">주문한 메뉴에만 리뷰를 남길 수 있어요.</p>`;
  const others = reviews.filter((r) => r.id !== mine?.id);
  $("#rvSheet").innerHTML =
    head(esc(menu.name)) +
    `<div class="rvs"><div class="ph" aria-hidden="true">${img(menu)}</div><div>${
      menu.reviewCount
        ? `<b>${menu.ratingAvg.toFixed(1)}</b>${stars(Math.round(menu.ratingAvg))}<span>리뷰 ${menu.reviewCount}개</span>`
        : `<span>아직 리뷰가 없어요</span>`
    }${menu.description ? `<p>${esc(menu.description)}</p>` : ""}</div></div>` +
    `<p class="lab">내 리뷰</p>${my}` +
    `<p class="lab">최신 리뷰</p>${others.length ? others.map((r) => rvCard(r, false)).join("") : '<div class="empty">다른 사람의 리뷰가 아직 없어요</div>'}`;
}
async function saveRv() {
  const { rating, content } = rv.draft;
  if (!rating) return toast("별점을 선택해주세요");
  if (!content.trim()) return toast("리뷰 내용을 입력해주세요");
  const mine = rv.data.me?.review;
  rv.saving = true;
  renderRv();
  try {
    await api(mine ? `/reviews/${mine.id}` : `/menus/${rv.menuId}/reviews`, {
      method: mine ? "PUT" : "POST",
      body: { rating, content },
    });
    toast(mine ? "리뷰를 수정했어요" : "리뷰를 등록했어요");
    Object.assign(rv, {
      editing: false,
      saving: false,
      draft: { rating: 0, content: "" },
    });
    myReviews = reviewable = null;
    if (cur === "me") loadMyReviews();
    if (cur === "write") loadReviewable();
    await loadRv();
  } catch (e) {
    if (rv) rv.saving = false;
    toast(e.message);
    renderRv();
  }
}
async function deleteRv() {
  if (!rv.confirmDel) {
    rv.confirmDel = true;
    return renderRv();
  }
  try {
    await api(`/reviews/${rv.data.me.review.id}`, { method: "DELETE" });
    toast("리뷰를 삭제했어요");
    rv.confirmDel = false;
    myReviews = reviewable = null;
    if (cur === "me") loadMyReviews();
    if (cur === "write") loadReviewable();
    await loadRv();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- 동작 ---------- */

async function toggleFav(id) {
  const m = get(id);
  const on = !m.favorite;
  m.favorite = on;
  render();
  try {
    await api(`/favorites/${id}`, { method: on ? "PUT" : "DELETE" });
    toast(on ? `${m.name}을(를) 즐겨찾기에 담았어요` : "즐겨찾기에서 뺐어요");
  } catch (e) {
    m.favorite = !on;
    render();
    toast(e.message);
  }
}

async function reorder(id) {
  try {
    const r = await api(`/orders/${id}/reorder`, {
      method: "POST",
      body: { cart },
    });
    cart = r.cart;
    await loadMenus(); // 현재 가격/재고 반영
    const added = r.results.filter((x) => x.added > 0);
    const soldOut = r.results
      .filter((x) => x.status === "sold_out")
      .map((x) => x.name);
    const capped = r.results
      .filter((x) => x.status === "partial" || x.status === "limit")
      .map((x) => x.name);
    const notes = [
      soldOut.length && `품절 제외: ${soldOut.join(", ")}`,
      capped.length && `재고만큼만 담음: ${capped.join(", ")}`,
    ].filter(Boolean);
    if (!added.length)
      return toast(notes.join(" · ") || "담을 수 있는 메뉴가 없어요");
    toast(
      `${added.length}개 메뉴(${added.reduce((s, x) => s + x.added, 0)}개)를 장바구니에 담았어요` +
        (notes.length ? ` · ${notes.join(" · ")}` : ""),
    );
    go("cart");
  } catch (e) {
    toast(e.message);
  }
}

// 주문 완료 화면(교환권 + 영수증). 주문 직후와 주문내역의 '현재' 주문에서 사용
function showDone(order, from) {
  $("#ticketNo").textContent = order.ticketNo;
  $("#rcTotal").textContent = won(order.totalAmount);
  $("#rcList").innerHTML = order.items
    .map(
      (l) =>
        `<div class="rl"><div>${esc(l.name)}<em>${esc(l.category)}</em></div><span class="q">${l.quantity}</span><span>${(l.unitPrice * l.quantity).toLocaleString()}</span></div>`,
    )
    .join("");
  const b = $("#doneBtn");
  b.dataset.go = from === "history" ? "history" : "home";
  b.textContent =
    from === "history" ? "주문내역으로 돌아가기" : "홈으로 돌아가기";
  go("done");
}

async function placeOrder() {
  const ls = lines();
  if (!ls.length || busy) return;
  busy = true;
  render();
  try {
    const { order } = await api("/orders", {
      method: "POST",
      body: {
        payMethod: PAY[pay],
        items: ls.map((l) => ({ menuId: l.id, quantity: l.q })),
      },
    });
    cart = {};
    orders = stats = reviewable = null;
    busy = false;
    showDone(order);
    trail = [];
  } catch (e) {
    busy = false;
    if (e.data?.error === "out_of_stock" || e.status === 404) {
      await loadMenus(true);
      toast(`${e.message} · 장바구니를 남은 수량에 맞췄어요`);
      go("cart", true);
    } else (toast(e.message), render());
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button,[data-go],[data-rvclose],[data-ticket]");
  if (!t) return;
  const d = t.dataset;
  if (d.go) {
    if (d.go === "cart")
      ($("#sheet").classList.remove("on"), $("#dim").classList.remove("on"));
    return go(d.go);
  }
  if (d.back) return go(d.back, true);
  if ("start" in d) return booted.then(() => go(user ? "home" : "login"));
  if (d.login) {
    if (providers.includes(d.login))
      return (location.href = `/api/auth/${d.login}/start`);
    return toast(`${PROVIDER_LABEL[d.login]} 로그인이 아직 설정되지 않았어요`);
  }
  if ("logout" in d)
    return api("/auth/logout", { method: "POST" })
      .then(() => signedOut("로그아웃했어요"))
      .catch((err) => toast(err.message));
  if (d.tab) {
    tab = d.tab;
    return render();
  }
  if (d.d) {
    const id = d.id,
      m = get(id),
      q = (cart[id] || 0) + +d.d;
    if (!m) return;
    if (+d.d > 0 && q > m.stock)
      return toast(
        m.stock
          ? `재고가 부족해요 (남은 수량 ${m.stock}개)`
          : "품절된 메뉴예요",
      );
    cart[id] = Math.max(0, q);
    if (!cart[id]) delete cart[id];
    return render();
  }
  if (d.pay) {
    pay = +d.pay;
    return render();
  }
  if (d.fav) return toggleFav(+d.fav);
  if (d.reorder) return reorder(+d.reorder);
  if (d.ticket) {
    const o = orders?.find((x) => x.id === +d.ticket);
    return o && showDone(o, "history");
  }
  if (d.foodtab) {
    foodTab = d.foodtab;
    $("#foodList").scrollTop = 0;
    return renderFood();
  }
  if (d.retry) {
    if (d.retry === "menus") ((menusErr = ""), render(), loadMenus());
    if (d.retry === "history") ((ordersErr = ""), render(), loadOrders());
    if (d.retry === "stats") ((statsErr = ""), render(), loadStats());
    if (d.retry === "write") ((reviewableErr = ""), render(), loadReviewable());
    if (d.retry === "food") ((foodErr = ""), render(), loadFood());
    if (d.retry === "me") ((myReviewsErr = ""), render(), loadMyReviews());
    if (d.retry === "rv") ((rv.err = ""), renderRv(), loadRv());
    return;
  }
  if (d.rv) return openRv(d.rv, d.rvmode);
  if ("rvclose" in d) return closeRv();
  if (d.star) {
    rv.draft.rating = +d.star;
    return renderRv();
  }
  if ("rvedit" in d) {
    const r = rv.data.me.review;
    Object.assign(rv, {
      editing: true,
      confirmDel: false,
      draft: { rating: r.rating, content: r.content },
    });
    return renderRv();
  }
  if ("rvcancel" in d) {
    Object.assign(rv, { editing: false, draft: { rating: 0, content: "" } });
    return renderRv();
  }
  if ("rvdel" in d) return deleteRv();
  if (t.id === "fab") {
    $("#sheet").classList.add("on");
    $("#dim").classList.add("on");
  }
  if (t.id === "shClose") {
    $("#sheet").classList.remove("on");
    $("#dim").classList.remove("on");
  }
  if (t.id === "placeBtn") placeOrder();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "rvText" && rv) {
    rv.draft.content = e.target.value;
    $("#rvCnt").textContent = `${e.target.value.length}/500`;
  }
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "rvForm") return;
  e.preventDefault();
  saveRv();
});
$("#sort").addEventListener("change", (e) => {
  sort = e.target.value;
  loadMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && rv) closeRv();
  if ((e.key === "Enter" || e.key === " ") && e.target.dataset?.ticket) {
    e.preventDefault();
    e.target.click();
  }
});
$("#dim").onclick = () => {
  $("#sheet").classList.remove("on");
  $("#dim").classList.remove("on");
};
render();
booted = boot();
// 홈/혼잡도 화면을 보고 있는 동안 30초마다 혼잡도 갱신
setInterval(() => {
  if (user && (cur === "home" || cur === "crowd") && !document.hidden)
    loadCrowd();
}, 30000);
