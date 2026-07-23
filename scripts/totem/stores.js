import "dotenv/config";
import { fail, formatFetchError, getConfig, getStores } from "./lib/client.js";
import { printStores } from "./lib/display.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { status: "" };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--status" && args[i + 1]) {
      options.status = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Uso:
  npm run stores
  npm run stores -- --status active

Variável .env opcional:
  STORE_STATUS=active|suspended|implantation|point|rental|paused|cancellation`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const config = getConfig();
  const args = parseArgs();
  const status = args.status || config.storeStatus || "";

  const stores = await getStores({ status: status || undefined }, config);
  printStores(stores, { status: status || undefined });
}

main().catch((error) => {
  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/stores`));
});
