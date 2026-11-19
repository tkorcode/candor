// The public functions of the service.
const { createInvoice, lineTotal } = require("./invoice");
const { applyDiscount } = require("./discount");
const { taxFor } = require("./tax");
const { formatInvoice } = require("./format");

module.exports = { createInvoice, lineTotal, applyDiscount, taxFor, formatInvoice };
