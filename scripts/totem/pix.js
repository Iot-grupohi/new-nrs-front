import "dotenv/config";
import {
  createPixPayment,
  fail,
  formatFetchError,
  getConfig,
  getStoreByCode,
  loginCustomer,
} from "./lib/client.js";
import { printPixPayment } from "./lib/display.js";
import { explainPixError } from "./lib/pix-errors.js";
import { askCredentials } from "./lib/prompt.js";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

async function askAmount(defaultAmount) {
  const rl = createInterface({ input, output });
  const prompt = defaultAmount
    ? `Valor (R$) [${defaultAmount}]: `
    : "Valor (R$): ";
  const answer = (await rl.question(prompt)).trim();
  rl.close();
  return answer || defaultAmount;
}

async function askOptional(label, defaultValue = "") {
  const rl = createInterface({ input, output });
  const prompt = defaultValue
    ? `${label} [${defaultValue}] (Enter p/ pular): `
    : `${label} (Enter p/ pular): `;
  const answer = (await rl.question(prompt)).trim();
  rl.close();
  return answer || defaultValue;
}

function readArgs() {
  const [, , amountArg, storeArg] = process.argv;
  if (!amountArg) return null;
  return {
    amount: amountArg,
    storeCode: storeArg || "",
  };
}

async function checkStoreForPix(storeCode, config) {
  const store = await getStoreByCode(storeCode, config);
  if (!store) {
    console.warn(`Aviso: loja ${storeCode} não encontrada na listagem.\n`);
    return;
  }

  const attrs = store.attributes ?? {};
  console.log(`Loja: ${attrs.name} | status: ${attrs.status} | HiBank: ${attrs["hibank-status"] ?? "não configurado"}`);

  if (attrs.status === "suspended") {
    fail(`A loja ${storeCode} está suspensa. Escolha outra loja.`);
  }

  if (!attrs["hibank-status"]) {
    console.warn("Aviso: loja sem HiBank — PIX provavelmente falhará.\n");
  }
}

async function main() {
  const config = getConfig();
  const args = readArgs();

  console.log("Pagamento PIX Lav60\n");

  const credentials = args ? null : await askCredentials();

  let storeCode = args?.storeCode || config.storeCode || "PB05";
  let amount = args?.amount || config.pixAmount;
  let productId = config.productId;
  let couponCode = config.couponCode;

  if (!amount) {
    amount = await askAmount("50.00");
  }

  if (!args?.storeCode) {
    storeCode = await askOptional("Código da loja", storeCode);
  }

  if (!args) {
    productId = await askOptional("Product ID", productId);
    couponCode = await askOptional("Cupom", couponCode);
  }

  console.log("\nVerificando loja...\n");
  await checkStoreForPix(storeCode, config);

  console.log("\nAutenticando cliente...\n");
  const session = await loginCustomer(config, credentials);

  console.log(`Gerando PIX de R$ ${amount} na loja ${storeCode}...\n`);

  const payment = await createPixPayment(
    {
      token: session.token,
      storeCode,
      amount,
      productId: productId || undefined,
      couponCode: couponCode || undefined,
    },
    config
  );

  printPixPayment(payment);
}

main().catch((error) => {
  const message = error.message ?? String(error);

  if (message.includes("Pagamento PIX falhou") || message.includes("401 Unauthorized")) {
    fail(explainPixError(message));
  }

  if (message && !error.cause) {
    fail(message);
  }

  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/payments/pix_to_hipag`));
});
