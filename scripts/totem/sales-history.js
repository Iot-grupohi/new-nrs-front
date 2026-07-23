import "dotenv/config";
import { fail, formatFetchError, getConfig } from "./lib/client.js";
import { printSalesReport } from "./lib/display-reports.js";
import { fetchSalesReport } from "./lib/oauth.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--store" && args[i + 1]) params.store_code = args[++i];
    else if (arg === "--customer" && args[i + 1]) params.customer_id = args[++i];
    else if (arg === "--start" && args[i + 1]) params.start_date = args[++i];
    else if (arg === "--end" && args[i + 1]) params.end_date = args[++i];
    else if (arg === "--page" && args[i + 1]) params.page = args[++i];
    else if (arg === "--per-page" && args[i + 1]) params.per_page = args[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Uso:
  npm run sales:history
  npm run sales:history -- --store PB05 --start 01/01/2026 --end 31/01/2026

Requer no .env:
  CLIENT_ID=...
  CLIENT_SECRET=...
  OAUTH_SCOPE=report_read

Filtros opcionais (dependem do backend):
  --store CODE
  --customer UUID
  --start DD/MM/YYYY
  --end DD/MM/YYYY
  --page N
  --per-page N`);
      process.exit(0);
    }
  }

  return params;
}

async function main() {
  const config = getConfig();
  const cliParams = parseArgs();

  const params = {
    store_code: cliParams.store_code || config.storeCode || undefined,
    customer_id: cliParams.customer_id || config.customerId || undefined,
    start_date: cliParams.start_date || config.reportStartDate || undefined,
    end_date: cliParams.end_date || config.reportEndDate || undefined,
    page: cliParams.page || config.reportPage || "1",
    per_page: cliParams.per_page || config.reportPerPage || "20",
  };

  console.log("Consultando relatório de vendas (OAuth2)...\n");

  const report = await fetchSalesReport(params, config);
  printSalesReport(report);
}

main().catch((error) => {
  if (error.message && !error.cause) {
    fail(error.message);
  }

  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/reports/sales`));
});
