import { fromCents } from "./money.js";

export function formatInvoice(invoice) {
  const rows = invoice.lines.map((l) => `${l.name} x${l.quantity}`);
  return [
    `Invoice for ${invoice.customer}`,
    ...rows,
    `Subtotal ${fromCents(invoice.subtotal).toFixed(2)}`,
    `Tax ${fromCents(invoice.tax).toFixed(2)}`,
    `Total ${fromCents(invoice.total).toFixed(2)}`,
  ].join("\n");
}
