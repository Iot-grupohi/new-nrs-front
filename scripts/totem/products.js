import "dotenv/config";
import { fail, formatFetchError, getConfig, getProducts } from "./lib/client.js";
import { printProducts } from "./lib/display.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { scope: "", storeCode: "" };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--scope" && args[i + 1]) {
      options.scope = args[++i];
    } else if ((arg === "--store" || arg === "--store-code") && args[i + 1]) {
      options.storeCode = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Uso:
  npm run products
  npm run products -- --scope new_totem --store PB05

Variáveis .env opcionais:
  PRODUCT_SCOPE=totem|new_totem|virtual_store
  STORE_CODE=PB05`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const config = getConfig();
  const args = parseArgs();
  const scope = args.scope || config.productScope || "";
  const storeCode = args.storeCode || config.storeCode || "";

  if (scope === "new_totem" && !storeCode) {
    console.warn("Aviso: scope=new_totem funciona melhor com --store CODE para preços promocionais.\n");
  }

  const products = await getProducts({ scope: scope || undefined, storeCode: storeCode || undefined }, config);
  printProducts(products, {
    scope: scope || "totem",
    storeCode: storeCode || undefined,
  });
}

main().catch((error) => {
  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/products`));
});
