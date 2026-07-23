export function printSalesReport(report) {
  const rows = report.data ?? [];
  const meta = report.meta ?? {};

  console.log(`\nRelatório de vendas (${rows.length} registro(s) nesta página)\n`);

  if (meta.total != null) {
    console.log(`Total: ${meta.total} | Página: ${meta.page ?? 1} / ${meta.total_pages ?? "?"}`);
  }

  if (rows.length === 0) {
    console.log("Nenhuma venda encontrada no período/filtros informados.");
    return;
  }

  for (const row of rows) {
    const attrs = row.attributes ?? row;
    const parts = [
      attrs["created-at"] || attrs.created_at,
      attrs["store-code"] || attrs.store_code,
      attrs["customer-full-name"] || attrs.customer_full_name || attrs["customer-id"],
      `R$ ${attrs["total-value"] ?? attrs.total_value ?? "?"}`,
      attrs["payment-method"] || attrs.payment_method,
    ].filter(Boolean);

    console.log(`- [${row.id ?? "?"}] ${parts.join(" | ")}`);
  }
}
