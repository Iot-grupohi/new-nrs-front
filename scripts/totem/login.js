import "dotenv/config";
import {
  fail,
  formatFetchError,
  getConfig,
  loginCustomer,
} from "./lib/client.js";

async function main() {
  const session = await loginCustomer();

  console.log("Login realizado com sucesso\n");
  console.log(`Cliente ID : ${session.id}`);
  console.log(`Email      : ${session.email ?? "(não informado)"}`);
  console.log(`Expira em  : ${session.time}`);
  console.log(`JWT Token  : ${session.token}`);
  console.log("\nUse o token nas requisições:");
  console.log(`Authorization: Bearer ${session.token}`);
}

main().catch((error) => {
  const { baseUrl } = getConfig();
  fail(formatFetchError(error, `${baseUrl}/api/v1/customers/auth/login`));
});
