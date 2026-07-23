import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

export function normalizeTaxId(value) {
  return value.replace(/\D/g, "");
}

export async function ask(question) {
  const rl = createInterface({ input, output });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}

export function askPassword(prompt = "Senha: ") {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    const stdin = process.stdin;

    if (!stdin.isTTY) {
      stdin.resume();
      stdin.once("data", (data) => resolve(String(data).trim()));
      return;
    }

    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");

    let password = "";

    const onData = (char) => {
      if (char === "\r" || char === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(password);
        return;
      }

      if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(0);
      }

      if (char === "\u007f" || char === "\b") {
        password = password.slice(0, -1);
        return;
      }

      password += char;
      process.stdout.write("*");
    };

    stdin.on("data", onData);
  });
}

export async function askCredentials() {
  console.log("Acesso à conta Lav60\n");

  const taxIdNumber = normalizeTaxId(await ask("CPF: "));
  if (!taxIdNumber) {
    throw new Error("CPF é obrigatório");
  }

  const password = await askPassword("Senha: ");
  if (!password) {
    throw new Error("Senha é obrigatória");
  }

  return { taxIdNumber, password };
}

export async function askCouponDetails(defaultStoreCode = "") {
  const couponCode = (await ask("Código do cupom: ")).trim().toUpperCase();
  if (!couponCode) {
    throw new Error("Código do cupom é obrigatório");
  }

  const storePrompt = defaultStoreCode
    ? `Código da loja [${defaultStoreCode}]: `
    : "Código da loja: ";
  const storeInput = (await ask(storePrompt)).trim();
  const storeCode = storeInput || defaultStoreCode;

  if (!storeCode) {
    throw new Error("Código da loja é obrigatório");
  }

  return { couponCode, storeCode };
}
