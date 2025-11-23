// src/services/pricing.js
// Reglas de negocio fijas por sector + modo de compra (single/bulk) + IVA opcional

const IVA_RATE = Number(process.env.IVA_RATE ?? 0.16);
const IVA_INCLUDED = (process.env.IVA_INCLUDED ?? "false").toLowerCase() === "true";

// Catálogo (deja la imagen editable en el front; aquí solo usamos id y name para MP)
const CATALOG = {
  hidrocheck: {
    id: "hidrocheck",
    name: "HidroCheck TDS-3",
    price_list: 999, // informativo (no se usa para el cálculo final)
  },
};

/**
 * Reglas fijas por SECTOR:
 * - escuela:   SOLO "single" (1 pieza). Precio 500 MXN. No se permite bulk.
 * - empresa:   single: 999, bulk: 650 c/u (aplica desde qty >= 2, tú defines el umbral si quieres)
 * - gobierno:  single: 1200, bulk: 850 c/u (aplica desde qty >= 2)
 */
const RULES = {
  escuela: {
    allowsBulk: false,
    singlePrice: 500,
    bulkPrice: null,       // sin bulk
    bulkMinQty: null,      // n/a
  },
  empresa: {
    allowsBulk: true,
    singlePrice: 999,
    bulkPrice: 650,
    bulkMinQty: 2,
  },
  gobierno: {
    allowsBulk: true,
    singlePrice: 1200,
    bulkPrice: 850,
    bulkMinQty: 2,
  },
  // default sector (general) -> tratamos como "empresa" para compatibilidad
  general: {
    allowsBulk: true,
    singlePrice: 999,
    bulkPrice: 650,
    bulkMinQty: 2,
  },
};

/**
 * priceCart(cart, sector, mode)
 * - cart: [{id, qty}]
 * - sector: "escuela" | "empresa" | "gobierno" | "general"
 * - mode: "single" | "bulk"
 *
 * Retorna breakdown con unit_net (sin IVA si IVA_INCLUDED=false) y total.
 */
function priceCart(cart = [], sector = "general", mode = "single") {
  if (!Array.isArray(cart)) cart = [];
  sector = (sector || "general").toLowerCase();
  const rule = RULES[sector] || RULES.general;

  // Validaciones de negocio:
  const totalQty = cart.reduce((a, b) => a + Math.max(1, Number(b.qty || 1)), 0);

  // ESCUELA: solo 1 pieza
  if (!rule.allowsBulk) {
    if (mode === "bulk" || totalQty > 1) {
      const err = new Error("Las cuentas de tipo 'escuela' no pueden comprar por mayoreo ni más de 1 pieza.");
      err.code = "escuela_solo_uno";
      throw err;
    }
  }

  // Determinar precio unitario según modo/sector:
  let unitPrice = rule.singlePrice;

  if (rule.allowsBulk && mode === "bulk") {
    // si definiste un umbral de bulk, puedes validarlo:
    if (rule.bulkMinQty && totalQty < rule.bulkMinQty) {
      // si no cumple el mínimo, mantenemos singlePrice (o lanza error si prefieres)
      unitPrice = rule.singlePrice;
    } else {
      unitPrice = rule.bulkPrice ?? rule.singlePrice;
    }
  }

  // Construir items usando un mismo unitario para todo el pedido (1 SKU único)
  const items = [];
  let subtotalNet = 0;

  for (const line of cart) {
    const qty = Math.max(1, Number(line.qty || 1));
    const sku = getSkuOrThrow(line.id);

    const lineNet = unitPrice * qty;
    subtotalNet += lineNet;

    items.push({
      id: sku.id,
      name: sku.name,
      qty,
      unit_net: round(unitPrice),
      line_net: round(lineNet),
    });
  }

  // IVA
  let tax = 0;
  if (IVA_INCLUDED) {
    tax = subtotalNet - subtotalNet / (1 + IVA_RATE);
  } else {
    tax = subtotalNet * IVA_RATE;
  }
  const total = IVA_INCLUDED ? subtotalNet : subtotalNet + tax;

  return {
    sector,
    mode,
    currency: "MXN",
    iva: { rate: IVA_RATE, included: IVA_INCLUDED },
    counts: {
      lines: items.length,
      items: totalQty,
    },
    items,
    totals: {
      subtotal_net: round(subtotalNet),
      tax: round(tax),
      total: round(total),
    },
  };
}

function getSkuOrThrow(id) {
  const sku = CATALOG[id];
  if (!sku) throw new Error(`SKU no reconocido: ${id}`);
  return sku;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  CATALOG,
  RULES,
  priceCart,
};
