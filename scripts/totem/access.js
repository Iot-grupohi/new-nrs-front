import "dotenv/config";
import {
  fail,
  formatFetchError,
  getConfig,
  getCustomerAccount,
  loginCustomer,
} from "./lib/client.js";
import { printAccount } from "./lib/display.js";
import { askCredentials, normalizeTaxId } from "./lib/prompt.js";

function readCredentialsFromArgs() {
  const [, , cpfArg, passwordArg] = process.argv;

  if (!cpfArg && !passwordArg) {
    return null;
  }

  if (!cpfArg || !passwordArg) {
    fail("Use: npm run access -- <cpf> <senha>");
  }

  return {
    taxIdNumber: normalizeTaxId(cpfArg),
    password: passwordArg,
  };
}

async function main() {
  const config = getConfig();
  const credentials = readCredentialsFromArgs() ?? (await askCredentials());

  console.log("\nAcessando conta...\n");

  const session = await loginCustomer(config, credentials);
  const customer = await getCustomerAccount(session.token, config);

  printAccount(customer);
}

main().catch((error) => {
  if (error.message && !error.cause) {
    fail(error.message);
  }

  const config = getConfig();
  fail(formatFetchError(error, `${config.baseUrl}/api/v1/customers/bubble/customer`));
});
