import "dotenv/config";
import {
  fail,
  formatFetchError,
  getConfig,
  getCustomerAccount,
  loginCustomer,
} from "./lib/client.js";
import { printAccount } from "./lib/display.js";

async function main() {
  const config = getConfig();
  let token = config.customerJwt;

  if (!token) {
    console.log("JWT não informado — realizando login...\n");
    const session = await loginCustomer(config);
    token = session.token;
    console.log(`Login OK (expira em ${session.time})\n`);
  }

  const customer = await getCustomerAccount(token, config);
  printAccount(customer);
}

main().catch((error) => {
  const config = getConfig();
  fail(formatFetchError(error, `${config.baseUrl}/api/v1/customers/bubble/customer`));
});
