// 외부 로그인(OAuth 2.0 Authorization Code) 연동부 + 세션.
// 공급자별 클라이언트 ID/시크릿은 서버 환경변수에서만 읽으며, 공급자 액세스 토큰은
// 서버에서 프로필 조회에만 쓰고 저장하거나 프론트엔드로 보내지 않는다.
// 환경변수가 설정된 공급자만 활성화된다 (.env.example 참고).
//
// 세션은 DB 에 두지 않고 서버 비밀키로 HMAC 서명한 쿠키에 담는다.
// 서버리스(Vercel)처럼 인스턴스마다 DB 가 다르거나 초기화돼도 로그인이 유지된다.
const crypto = require("crypto");

const PROVIDERS = {
  kakao: {
    label: "카카오톡",
    env: "KAKAO",
    authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    scope: "",
    profile: (p) => ({
      providerUserId: p.id,
      name: p.kakao_account?.profile?.nickname || p.properties?.nickname,
      email: p.kakao_account?.email,
      profileImage: p.kakao_account?.profile?.profile_image_url,
    }),
  },
  naver: {
    label: "네이버",
    env: "NAVER",
    authorizeUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    profile: ({ response: p = {} }) => ({
      providerUserId: p.id,
      name: p.name || p.nickname,
      email: p.email,
      profileImage: p.profile_image,
    }),
  },
  google: {
    label: "구글",
    env: "GOOGLE",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid profile email",
    profile: (p) => ({ providerUserId: p.sub, name: p.name, email: p.email, profileImage: p.picture }),
  },
};

const SESSION_COOKIE = "sid";
const SESSION_DAYS = 7;
const STATE_COOKIE = "oauth_state";

function credentials(key, env = process.env) {
  const p = PROVIDERS[key];
  const id = p && env[`${p.env}_CLIENT_ID`];
  if (!id) return null;
  return { id, secret: env[`${p.env}_CLIENT_SECRET`] || "" };
}

// 서명 키: SESSION_SECRET 우선. 없으면 공급자 시크릿에서 고정 키를 만들어 모든 인스턴스가 같은 키를 쓰게 한다.
function sessionSecret(env = process.env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const secrets = Object.values(PROVIDERS)
    .map((p) => env[`${p.env}_CLIENT_SECRET`])
    .filter(Boolean);
  if (secrets.length)
    return crypto.createHash("sha256").update(`haksik-session:${secrets.join(":")}`).digest("hex");
  if (env.VERCEL) console.warn("SESSION_SECRET 이 없어 서버 인스턴스마다 로그인이 풀릴 수 있습니다.");
  return crypto.randomBytes(32).toString("hex");
}
const SECRET = sessionSecret();
const mac = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

// 쿠키 값 = base64url(JSON 사용자 정보 + 만료 시각) + "." + 서명
function signSession(user, days = SESSION_DAYS) {
  const data = Buffer.from(
    JSON.stringify({
      p: user.provider,
      i: String(user.providerUserId),
      n: user.name,
      e: user.email || null,
      img: user.profileImage || null,
      exp: Date.now() + days * 864e5,
    }),
  ).toString("base64url");
  return `${data}.${mac(data)}`;
}

function verifySession(token) {
  const [data, sig] = String(token || "").split(".");
  if (!data || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(data));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString());
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function enabledProviders(env = process.env) {
  return Object.keys(PROVIDERS).filter((k) => credentials(k, env));
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOpts(req, maxAge) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1" || req.secure,
    path: "/",
    maxAge,
  };
}

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
const redirectUri = (req, key) => `${baseUrl(req)}/api/auth/${key}/callback`;

// 인가 코드 → 액세스 토큰 → 프로필. 실패 시 예외.
async function fetchProfile(key, code, state, redirect) {
  const p = PROVIDERS[key];
  const cred = credentials(key);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cred.id,
    redirect_uri: redirect,
    code,
    state,
  });
  if (cred.secret) body.set("client_secret", cred.secret);
  const tr = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const token = await tr.json().catch(() => ({}));
  if (!tr.ok || !token.access_token) throw new Error(`token exchange failed (${tr.status})`);
  const pr = await fetch(p.profileUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!pr.ok) throw new Error(`profile request failed (${pr.status})`);
  const prof = p.profile(await pr.json());
  if (!prof.providerUserId) throw new Error("profile has no id");
  return { ...prof, provider: key, name: prof.name || `${p.label} 사용자` };
}

function authRoutes(router, store) {
  router.get("/auth/providers", (req, res) => {
    res.json({ providers: enabledProviders() });
  });

  router.get("/auth/:provider/start", (req, res) => {
    const key = req.params.provider;
    const cred = credentials(key);
    if (!cred) return res.redirect("/?login_error=provider_disabled");
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, `${key}:${state}`, cookieOpts(req, 10 * 60 * 1000));
    const url = new URL(PROVIDERS[key].authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: cred.id,
      redirect_uri: redirectUri(req, key),
      state,
      ...(PROVIDERS[key].scope && { scope: PROVIDERS[key].scope }),
    });
    res.redirect(url.toString());
  });

  router.get("/auth/:provider/callback", async (req, res) => {
    const key = req.params.provider;
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: "/" });
    const { code, state, error } = req.query;
    if (!credentials(key)) return res.redirect("/?login_error=provider_disabled");
    if (error) return res.redirect("/?login_error=denied");
    // CSRF 방지: 시작 시 쿠키에 저장한 state 와 일치해야 함
    if (!code || !state || expected !== `${key}:${state}`)
      return res.redirect("/?login_error=invalid_state");
    try {
      const profile = await fetchProfile(key, String(code), String(state), redirectUri(req, key));
      const user = store.upsertUser(profile);
      res.cookie(
        SESSION_COOKIE,
        signSession({ ...user, providerUserId: profile.providerUserId }),
        cookieOpts(req, SESSION_DAYS * 864e5),
      );
      res.redirect("/?login=ok");
    } catch (e) {
      console.error(`[auth:${key}]`, e.message);
      res.redirect("/?login_error=failed");
    }
  });

  router.post("/auth/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });
}

// 모든 요청에 req.user 부여 (세션이 유효할 때만)
function sessionMiddleware(store) {
  return (req, res, next) => {
    const s = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    req.user = s
      ? store.ensureUser({ provider: s.p, providerUserId: s.i, name: s.n, email: s.e, profileImage: s.img })
      : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized", message: "로그인이 필요해요." });
  next();
}

module.exports = {
  PROVIDERS,
  SESSION_COOKIE,
  signSession,
  authRoutes,
  sessionMiddleware,
  requireAuth,
  enabledProviders,
};
