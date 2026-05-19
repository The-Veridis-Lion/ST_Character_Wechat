const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env") });

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

async function main() {
  const baseUrl = String(process.env.ST_CHARACTER_WECHAT_WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com").trim();
  const botType = String(process.env.ST_CHARACTER_WECHAT_WEIXIN_QR_BOT_TYPE || "3").trim();
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, ensureTrailingSlash(baseUrl));
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${body}`);
  }
  const data = await response.json();
  const loginUrl = String(data.qrcode_img_content || "").trim();
  if (!loginUrl) {
    throw new Error("QR response did not include qrcode_img_content");
  }
  console.log(loginUrl);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
