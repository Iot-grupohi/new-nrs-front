import { explainPixError } from "./pix-errors.js";

export function getConfig() {
  return {
    baseUrl: process.env.BASE_URL?.replace(/\/$/, ""),
    xToken: process.env.X_TOKEN,
    email: process.env.EMAIL,
    taxIdNumber: process.env.TAX_ID_NUMBER,
    password: process.env.PASSWORD,
    customerJwt: process.env.CUSTOMER_JWT?.trim() || "",
    storeCode: process.env.STORE_CODE?.trim() || "",
    productScope: process.env.PRODUCT_SCOPE?.trim() || "",
    storeStatus: process.env.STORE_STATUS?.trim() || "",
    couponCode: process.env.COUPON_CODE?.trim() || "",
    customerId: process.env.CUSTOMER_ID?.trim() || "",
    clientId: process.env.CLIENT_ID?.trim() || "",
    clientSecret: process.env.CLIENT_SECRET?.trim() || "",
    oauthScope: process.env.OAUTH_SCOPE?.trim() || "report_read",
    reportStartDate: process.env.REPORT_START_DATE?.trim() || "",
    reportEndDate: process.env.REPORT_END_DATE?.trim() || "",
    reportPage: process.env.REPORT_PAGE?.trim() || "",
    reportPerPage: process.env.REPORT_PER_PAGE?.trim() || "",
    pixAmount: process.env.PIX_AMOUNT?.trim() || "",
    productId: process.env.PRODUCT_ID?.trim() || "",
    machineCode: process.env.MACHINE_CODE?.trim() || "",
    paymentMethod: process.env.PAYMENT_METHOD?.trim() || "credits",
  };
}

export function fail(message) {
  console.error(`Erro: ${message}`);
  throw new Error(message);
}

export function formatFetchError(error, url) {
  const cause = error.cause ?? error;

  if (cause.code === "ENOTFOUND") {
    return [
      `Não foi possível resolver o host: ${cause.hostname ?? url}`,
      "Verifique se BASE_URL no .env está correto.",
      "Exemplo: https://staging.lavanderia60minutos.com.br",
    ].join("\n");
  }

  if (cause.code === "ECONNREFUSED") {
    return `Conexão recusada em ${url}. O servidor pode estar offline.`;
  }

  if (cause.code === "CERT_HAS_EXPIRED" || cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `Erro de certificado SSL ao acessar ${url}: ${cause.message}`;
  }

  const details = cause.message ?? error.message ?? String(error);
  return `Falha na requisição para ${url}: ${details}`;
}

function buildLoginBody(config, credentials) {
  if (credentials) {
    if (!credentials.password) {
      fail("Senha é obrigatória");
    }

    if (credentials.email) {
      return { email: credentials.email.trim(), password: credentials.password };
    }

    if (credentials.taxIdNumber) {
      return {
        tax_id_number: credentials.taxIdNumber.trim(),
        password: credentials.password,
      };
    }

    fail("Informe email ou CPF/CNPJ para login");
  }

  if (!config.password) {
    fail("Defina PASSWORD no arquivo .env");
  }

  const hasEmail = Boolean(config.email?.trim());
  const hasTaxId = Boolean(config.taxIdNumber?.trim());

  if (hasEmail && hasTaxId) {
    fail("Informe apenas EMAIL ou TAX_ID_NUMBER no .env, não ambos");
  }

  if (!hasEmail && !hasTaxId) {
    fail("Informe EMAIL ou TAX_ID_NUMBER no .env");
  }

  if (hasEmail) {
    return { email: config.email.trim(), password: config.password };
  }

  return { tax_id_number: config.taxIdNumber.trim(), password: config.password };
}

function validateBaseConfig(config) {
  if (!config.baseUrl) {
    fail("Defina BASE_URL no arquivo .env");
  }

  if (!config.xToken) {
    fail("Defina X_TOKEN no arquivo .env");
  }
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    fail(`${label} — resposta inválida (${response.status}): ${text}`);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      text ||
      `HTTP ${response.status}`;
    fail(`${label} falhou (${response.status}): ${message}`);
  }

  return data;
}

export async function loginCustomer(config = getConfig(), credentials = null) {
  validateBaseConfig(config);

  const body = buildLoginBody(config, credentials);
  const url = `${config.baseUrl}/api/v1/customers/auth/login`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Token": config.xToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonResponse(response, "Login");
  const { id, email, token, time } = data.data ?? {};

  if (!token) {
    fail("Login retornou sucesso, mas sem token JWT");
  }

  return { id, email, token, time };
}

export async function getCustomerAccount(token, config = getConfig()) {
  validateBaseConfig(config);

  const url = `${config.baseUrl}/api/v1/customers/bubble/customer`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Token": config.xToken,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const data = await parseJsonResponse(response, "Consulta da conta");
  return data.data;
}

export async function getStores({ status } = {}, config = getConfig()) {
  validateBaseConfig(config);

  const params = new URLSearchParams();
  if (status) {
    params.set("status", status);
  }

  const query = params.toString();
  const url = `${config.baseUrl}/api/v1/stores${query ? `?${query}` : ""}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Token": config.xToken,
      Accept: "application/json",
    },
  });

  const data = await parseJsonResponse(response, "Listagem de lojas");
  return data.data ?? [];
}

export async function getProducts({ scope, storeCode } = {}, config = getConfig()) {
  validateBaseConfig(config);

  const params = new URLSearchParams();
  if (scope) {
    params.set("scope", scope);
  }
  if (storeCode) {
    params.set("store_code", storeCode);
  }

  const query = params.toString();
  const url = `${config.baseUrl}/api/v1/products${query ? `?${query}` : ""}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Token": config.xToken,
      Accept: "application/json",
    },
  });

  const data = await parseJsonResponse(response, "Listagem de produtos");
  return data.data ?? [];
}

export async function getStoreByCode(storeCode, config = getConfig()) {
  const stores = await getStores({}, config);
  return stores.find((store) => store.attributes?.code === storeCode) ?? null;
}

export async function validateCoupon(
  { code, customerId, storeCode },
  config = getConfig()
) {
  validateBaseConfig(config);

  if (!code) {
    fail("Informe o código do cupom");
  }
  if (!customerId) {
    fail("Informe o customer_id do cliente");
  }
  if (!storeCode) {
    fail("Informe o store_code da loja");
  }

  const url = `${config.baseUrl}/api/v1/coupons/${encodeURIComponent(code)}/validate`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Token": config.xToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      customer_id: customerId,
      store_code: storeCode,
    }),
  });

  const data = await parseJsonResponse(response, "Validação de cupom");
  return data.data;
}

export async function createPixPayment(
  { token, storeCode, amount, productId, couponCode },
  config = getConfig()
) {
  validateBaseConfig(config);

  if (!token) {
    fail("JWT do cliente é obrigatório para PIX");
  }
  if (!storeCode) {
    fail("Informe o store_code da loja");
  }
  if (!amount || Number(amount) <= 0) {
    fail("Informe um amount válido maior que zero");
  }

  const body = {
    store_code: storeCode,
    amount: Number(amount),
  };

  if (productId) {
    body.product_id = productId;
  }
  if (couponCode) {
    body.coupon_code = couponCode;
  }

  const url = `${config.baseUrl}/api/v1/payments/pix_to_hipag`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Token": config.xToken,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    fail(`Pagamento PIX — resposta inválida (${response.status}): ${text}`);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      text ||
      `HTTP ${response.status}`;
    fail(
      explainPixError(`Pagamento PIX falhou (${response.status}): ${message}`)
    );
  }

  return data.data ?? data;
}

export async function createTotemSale(
  {
    token,
    storeCode,
    productId,
    value,
    quantity = "1",
    machineCode,
    soapType,
    paymentMethod = "credits",
    releasedMachine = false,
  },
  config = getConfig()
) {
  validateBaseConfig(config);

  if (!token) fail("JWT do cliente é obrigatório");
  if (!storeCode) fail("Informe o store_code");
  if (!productId) fail("Informe o product_id");
  if (!value) fail("Informe o value do item");
  if (!machineCode) fail("Informe o código da máquina");

  const machines = [{ code: machineCode }];
  const itemValue = String(value);
  const totalValue = (
    Number(itemValue) * Number(quantity) * machines.length
  ).toFixed(2);

  const body = {
    store_code: storeCode,
    released_machine: releasedMachine,
    sale_items: [
      {
        value: itemValue,
        quantity: String(quantity),
        product_id: productId,
        machines,
        ...(soapType ? { soap_type: soapType } : {}),
      },
    ],
    payments: [
      {
        value: totalValue,
        payment_method: paymentMethod,
      },
    ],
  };

  const url = `${config.baseUrl}/api/v1/sales/totem_sales`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Token": config.xToken,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await parseJsonResponse(response, "Venda no totem");
  return data.data;
}
