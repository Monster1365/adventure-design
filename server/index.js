const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { open } = require("./db");
const { createApp } = require("./app");
const { enabledProviders } = require("./auth");

const port = Number(process.env.PORT) || 3000;
createApp(open()).listen(port, () => {
  const on = enabledProviders();
  console.log(`학식먹자 서버: http://localhost:${port}`);
  console.log(
    on.length
      ? `활성화된 로그인 공급자: ${on.join(", ")}`
      : "활성화된 로그인 공급자가 없습니다. .env.example 을 참고해 .env 를 설정하세요.",
  );
});
