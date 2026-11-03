-- 학식먹자 PostgreSQL 스키마
-- 서버가 시작될 때마다 실행되므로 모든 문장은 여러 번 실행해도 안전해야 한다 (IF NOT EXISTS 등).
-- 시각은 TIMESTAMPTZ 이며, "오늘" 같은 날짜 경계는 쿼리에서 Asia/Seoul 기준으로 계산한다.

-- 사용자: 외부 로그인 공급자(provider) + 공급자 측 고유 ID 로 식별
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         TEXT        NOT NULL,
  provider_user_id TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  email            TEXT,
  profile_image    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

-- 로그인 세션: 쿠키에는 원본 토큰, DB 에는 SHA-256 해시만 저장
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT        PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 메뉴: rating_avg / review_count 는 reviews 트리거가 갱신하는 집계 캐시
CREATE TABLE IF NOT EXISTS menus (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category     TEXT             NOT NULL,
  name         TEXT             NOT NULL,
  description  TEXT             NOT NULL DEFAULT '',
  price        INTEGER          NOT NULL CHECK (price >= 0),
  image        TEXT             NOT NULL DEFAULT '',
  stock        INTEGER          NOT NULL DEFAULT 0 CHECK (stock >= 0),
  rating_avg   DOUBLE PRECISION,                       -- 리뷰가 없으면 NULL
  review_count INTEGER          NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  sort_order   INTEGER          NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menus_category ON menus(category, sort_order);
CREATE INDEX IF NOT EXISTS idx_menus_price    ON menus(price);
CREATE INDEX IF NOT EXISTS idx_menus_rating   ON menus(rating_avg);

-- 주문
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status       TEXT        NOT NULL DEFAULT 'placed'
               CHECK (status IN ('placed', 'completed', 'cancelled')),
  total_amount INTEGER     NOT NULL CHECK (total_amount >= 0),
  pay_method   TEXT        NOT NULL,
  ticket_no    INTEGER     NOT NULL,
  ordered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_time   ON orders(ordered_at);

-- 주문 상세: 주문 당시 단가(unit_price)를 따로 보관해 이후 가격 변경과 무관하게 유지
CREATE TABLE IF NOT EXISTS order_items (
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id    INTEGER NOT NULL REFERENCES menus(id)  ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (order_id, menu_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_menu ON order_items(menu_id);

-- 리뷰: 사용자당 메뉴별 1개
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_id    INTEGER     NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  rating     INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content    TEXT        NOT NULL CHECK (char_length(content) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, menu_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_menu ON reviews(menu_id, created_at DESC);

-- 즐겨찾기: 사용자가 직접 지정한 메뉴
-- (최근 주문 재주문은 orders / order_items 에서 바로 조회하므로 별도 테이블을 두지 않는다)
CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  menu_id    INTEGER     NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, menu_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_menu ON favorites(menu_id);

-- 식품 정보: 알레르기 유발물질 목록 / 메뉴별 알레르기 / 카테고리별 원산지
-- 내용은 server/food-info.js 가 원본이며 서버 시작 시 동기화된다 (db.js)
CREATE TABLE IF NOT EXISTS allergens (
  id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS menu_allergens (
  menu_id     INTEGER NOT NULL REFERENCES menus(id)     ON DELETE CASCADE,
  allergen_id INTEGER NOT NULL REFERENCES allergens(id) ON DELETE RESTRICT,
  PRIMARY KEY (menu_id, allergen_id)
);
CREATE INDEX IF NOT EXISTS idx_menu_allergens_allergen ON menu_allergens(allergen_id);

-- 원산지는 코너(menus.category) 단위로 표시한다
CREATE TABLE IF NOT EXISTS category_origins (
  category   TEXT    NOT NULL,
  ingredient TEXT    NOT NULL,
  origin     TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, ingredient)
);

-- 리뷰가 바뀔 때마다 해당 메뉴의 평균 별점/리뷰 수를 리뷰 테이블에서 다시 계산
CREATE OR REPLACE FUNCTION refresh_menu_rating() RETURNS trigger AS $$
DECLARE
  ids INTEGER[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    ids := ARRAY[NEW.menu_id];
  ELSIF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.menu_id];
  ELSE
    ids := ARRAY[OLD.menu_id, NEW.menu_id];
  END IF;
  UPDATE menus m SET
    rating_avg   = (SELECT AVG(rating)::DOUBLE PRECISION FROM reviews WHERE menu_id = m.id),
    review_count = (SELECT COUNT(*) FROM reviews WHERE menu_id = m.id)
  WHERE m.id = ANY(ids);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviews_rating ON reviews;
CREATE TRIGGER trg_reviews_rating
  AFTER INSERT OR DELETE OR UPDATE OF rating, menu_id ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_menu_rating();
