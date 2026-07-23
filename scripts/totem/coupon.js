import "dotenv/config";
import {
  fail,
  formatFetchError,
  getConfig,
  loginCustomer,
  validateCoupon,
} from "./lib/client.js";
import { printCoupon } from "./lib/display.js";
import { askCouponDetails, askCredentials } from "./lib/prompt.js";

function readArgs() {
  const [, , couponCode, storeCode] = process.argv;

  if (!couponCode && !storeCode) {
    return null;
  }

  if (!couponCode) {
    fail("Use: npm run coupon -- <codigo_cupom> [store_code]");
  }

  return {
    couponCode: couponCode.trim().toUpperCase(),
    storeCode: storeCode?.trim() || "",
  };
}

async function main() {
  const config = getConfig();
  const args = readArgs();
  let couponCode = args?.couponCode || config.couponCode;
  let storeCode = args?.storeCode || config.storeCode;
  let customerId = config.customerId;

  if (!couponCode || !storeCode) {
    console.log("Validação de cupom Lav60\n");
    const credentials = await askCredentials();
    const couponDetails = await askCouponDetails(config.storeCode || "PB05");

    couponCode = couponDetails.couponCode;
    storeCode = couponDetails.storeCode;

    console.log("\nAutenticando cliente...\n");
    const session = await loginCustomer(config, credentials);
    customerId = session.id;
  } else if (!customerId) {
    console.log("Obtendo customer_id via login...\n");
    const session = await loginCustomer(config);
    customerId = session.id;
  }

  console.log(`Validando cupom ${couponCode} na loja ${storeCode}...\n`);

  const coupon = await validateCoupon(
    { code: couponCode, customerId, storeCode },
    config
  );

  printCoupon(coupon);
}

main().catch((error) => {
  if (error.message && !error.cause) {
    fail(error.message);
  }

  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/coupons/{code}/validate`));
});
