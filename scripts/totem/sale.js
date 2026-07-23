import "dotenv/config";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import {
  createTotemSale,
  fail,
  formatFetchError,
  getConfig,
  getProducts,
  loginCustomer,
} from "./lib/client.js";
import { printProducts, printSale } from "./lib/display.js";
import { askCredentials } from "./lib/prompt.js";

async function ask(question, defaultValue = "") {
  const rl = createInterface({ input, output });
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : question;
  const answer = (await rl.question(prompt)).trim();
  rl.close();
  return answer || defaultValue;
}

async function pickProduct(products) {
  printProducts(products, { scope: "new_totem" });

  const choice = await ask("\nNúmero do produto (1-N) ou UUID: ");
  const index = Number(choice) - 1;

  if (Number.isInteger(index) && index >= 0 && index < products.length) {
    return products[index];
  }

  const byId = products.find((p) => p.id === choice);
  if (byId) return byId;

  throw new Error("Produto inválido — informe o número da lista ou o UUID");
}

function readArgs() {
  const [, , storeCode, productId, machineCode, value] = process.argv;
  if (!storeCode && !productId) return null;

  if (!storeCode || !productId || !machineCode || !value) {
    fail("Use: npm run sale -- <store_code> <product_id> <machine_code> <value>");
  }

  return { storeCode, productId, machineCode, value };
}

async function main() {
  const config = getConfig();
  const args = readArgs();

  console.log("Venda no totem Lav60\n");

  let credentials = null;
  if (!args) {
    credentials = await askCredentials();
  }

  console.log("\nAutenticando...\n");
  const session = await loginCustomer(config, credentials);

  let storeCode = args?.storeCode || config.storeCode || "PB05";
  let productId = args?.productId || config.productId;
  let machineCode = args?.machineCode || config.machineCode;
  let value = args?.value;

  if (!args) {
    storeCode = await ask("Código da loja", storeCode);

    console.log("\nCarregando produtos da loja...\n");
    const products = await getProducts(
      { scope: "new_totem", storeCode },
      config
    );

    if (products.length === 0) {
      fail("Nenhum produto encontrado para esta loja");
    }

    const product = await pickProduct(products);
    productId = product.id;
    value = product.attributes?.value;
  }

  if (!machineCode) {
    machineCode = await ask("Código da máquina (ex: M01, L01): ");
  }

  let soapType;
  if (!args) {
    const soapInput = await ask("Tipo de sabão (floral/sport/smelless, Enter p/ pular): ");
    soapType = ["floral", "sport", "smelless"].includes(soapInput) ? soapInput : undefined;
  }

  console.log(`\nCriando venda na loja ${storeCode}...\n`);

  const sale = await createTotemSale(
    {
      token: session.token,
      storeCode,
      productId,
      value,
      machineCode,
      soapType,
      paymentMethod: config.paymentMethod || "credits",
    },
    config
  );

  printSale(sale);
}

main().catch((error) => {
  if (error.message && !error.cause) {
    fail(error.message);
  }

  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/sales/totem_sales`));
});
