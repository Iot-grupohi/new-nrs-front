import "dotenv/config";
import { fail, formatFetchError, getConfig, getStores } from "./lib/client.js";

function formatHibank(value) {
  if (!value) return "não configurado";
  return value;
}

async function main() {
  const config = getConfig();
  const statusFilter = process.argv[2]?.replace("--status=", "") || process.argv[2] || "";

  console.log("\nLojas com HiBank — verificação PIX\n");

  const stores = await getStores(
    statusFilter ? { status: statusFilter } : {},
    config
  );

  const withHibank = stores.filter((s) => s.attributes?.["hibank-status"]);
  const withoutHibank = stores.filter((s) => !s.attributes?.["hibank-status"]);

  if (withHibank.length === 0) {
    console.log("Nenhuma loja com HiBank encontrada.");
  } else {
    console.log(`Com HiBank (${withHibank.length}):\n`);
    for (const store of withHibank) {
      const a = store.attributes;
      console.log(
        `  [${a.code}] ${a.name} — status: ${a.status} | HiBank: ${formatHibank(a["hibank-status"])}`
      );
    }
  }

  console.log(`\nSem HiBank: ${withoutHibank.length} loja(s)`);
  console.log("\nUse STORE_CODE de uma loja com HiBank active para npm run pix.");
  console.log("Nota: mesmo com HiBank active, staging pode retornar 401 do HiPag.\n");
}

main().catch((error) => {
  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/stores`));
});
