const STATUS_LABELS = {
  0: "ativo",
  1: "suspenso",
  active: "ativo",
  suspended: "suspenso",
};

function formatGender(value) {
  if (value === 1 || value === "female" || value === "feminino") return "feminino";
  if (value === 2 || value === "male" || value === "masculino") return "masculino";
  if (value === 0 || value === "other" || value === "outro") return "outro";
  return String(value ?? "-");
}

export function printAccount(customer) {
  const attrs = customer.attributes ?? {};

  console.log("\nConta do cliente\n");
  console.log(`ID                 : ${customer.id}`);
  console.log(`Nome               : ${attrs["first-name"] ?? ""} ${attrs["last-name"] ?? ""}`.trim());
  console.log(`Email              : ${attrs.email ?? "-"}`);
  console.log(`Telefone           : ${attrs.phone ?? "-"}`);
  console.log(`CPF/CNPJ           : ${attrs["tax-id-number"] ?? "-"}`);
  console.log(`Saldo de créditos  : R$ ${attrs.credits ?? "0.00"}`);
  console.log(`Status             : ${STATUS_LABELS[attrs.status] ?? attrs.status ?? "-"}`);
  console.log(`Loja de cadastro   : ${attrs["registration-store-code"] ?? "-"}`);
  console.log(`Loja virtual       : ${attrs["virtual-store"] ? "sim" : "não"}`);
  console.log(`Estrangeiro        : ${attrs.foreigner ? "sim" : "não"}`);
  console.log(`Gênero             : ${formatGender(attrs.gender)}`);
  console.log(`Nascimento         : ${attrs.birthdate ?? "-"}`);
  console.log(`CEP                : ${attrs.zipcode ?? "-"}`);
  console.log(`CPF validado       : ${attrs["tax-id-number-validated"] ? "sim" : "não"}`);
  console.log(`Criado em          : ${attrs["created-at"] ?? "-"}`);
  console.log(`Atualizado em      : ${attrs["updated-at"] ?? "-"}`);
}

export function printProducts(products, { scope, storeCode } = {}) {
  const label = [
    scope ? `scope=${scope}` : "scope=totem (padrão)",
    storeCode ? `loja=${storeCode}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  console.log(`\nProdutos (${products.length}) — ${label}\n`);

  if (products.length === 0) {
    console.log("Nenhum produto encontrado.");
    return;
  }

  for (const product of products) {
    const attrs = product.attributes ?? {};
    const extras = [];

    if (attrs["billing-method-name"]) {
      extras.push(`cobrança: ${attrs["billing-method-name"]}`);
    }
    if (attrs.coupon_value != null) {
      extras.push(`cupom: R$ ${attrs.coupon_value}`);
    }
    if (attrs["product-type"]) {
      extras.push(`tipo: ${attrs["product-type"]}`);
    }

    const suffix = extras.length ? ` (${extras.join(", ")})` : "";
    console.log(`- [${product.id}] ${attrs.name} — R$ ${attrs.value}${suffix}`);
  }
}

export function printStores(stores, { status } = {}) {
  const label = status ? `status=${status}` : "todas";

  console.log(`\nLojas (${stores.length}) — ${label}\n`);

  if (stores.length === 0) {
    console.log("Nenhuma loja encontrada.");
    return;
  }

  for (const store of stores) {
    const attrs = store.attributes ?? {};
    console.log(
      `- [${attrs.code}] ${attrs.name} — ${attrs.city ?? "?"} / ${attrs.state ?? "?"} (${attrs.status})`
    );
  }
}

const APPLY_METHOD_LABELS = {
  absolute: "valor fixo",
  percent: "percentual",
  cash: "crédito em dinheiro",
};

const COUPON_TYPE_LABELS = {
  bonus: "bônus",
  discount: "desconto",
};

export function printCoupon(coupon) {
  const attrs = coupon.attributes ?? {};

  console.log("\nCupom válido\n");
  console.log(`ID            : ${coupon.id}`);
  console.log(`Código        : ${attrs.code ?? "-"}`);
  console.log(`Tipo          : ${COUPON_TYPE_LABELS[attrs["coupon-type"]] ?? attrs["coupon-type"] ?? "-"}`);
  console.log(`Aplicação     : ${APPLY_METHOD_LABELS[attrs["apply-method"]] ?? attrs["apply-method"] ?? "-"}`);
  console.log(`Valor         : R$ ${attrs.value ?? "0.00"}`);
  console.log(`Horário       : ${attrs.start_time ?? "-"} até ${attrs.end_time ?? "-"} (se houver restrição)`);
  console.log("\nUse o código do cupom nos endpoints de compra de crédito (PIX).");
}

export function printPixPayment(payment) {
  const data = payment.data ?? payment;

  console.log("\nPagamento PIX criado\n");
  console.log(`ID pagamento : ${data.id ?? "-"}`);
  console.log(`Status       : ${data.status ?? "-"}`);
  console.log(`Valor        : R$ ${data.amount ?? "-"}`);
  console.log(`Expira em    : ${data.expires_at ?? "-"}`);
  console.log(`Criado em    : ${data.created_at ?? "-"}`);

  if (data.pix_qr_code) {
    const preview = data.pix_qr_code.length > 80
      ? `${data.pix_qr_code.slice(0, 80)}...`
      : data.pix_qr_code;
    console.log(`PIX copia/cola: ${preview}`);
  }

  if (data.pix_qr_code_base64) {
    console.log("QR Code base64 : disponível na resposta (pix_qr_code_base64)");
  }
}

export function printSale(sale) {
  const attrs = sale.attributes ?? {};

  console.log("\nVenda criada com sucesso\n");
  console.log(`ID venda     : ${sale.id}`);
  console.log(`Loja         : ${attrs["store-code"] ?? "-"}`);
  console.log(`Cliente      : ${attrs["customer-id"] ?? "-"}`);
  console.log(`Total        : R$ ${attrs["total-value"] ?? "-"}`);
  console.log(`Criada em    : ${attrs["created-at"] ?? "-"}`);

  const items = attrs["sale-items"] ?? [];
  if (items.length > 0) {
    console.log("\nItens:");
    for (const item of items) {
      console.log(`  - produto ${item.product_id} | R$ ${item.value} x ${item.quantity}`);
    }
  }
}
