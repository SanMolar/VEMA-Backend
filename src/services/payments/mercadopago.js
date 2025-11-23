// // services/payments/mercadopago.js
// // SDK v2 de Mercado Pago (NO existe .configure() en v2)
// const { MercadoPagoConfig, Preference } = require('mercadopago');

// /* ------------------------- ENV / Config ------------------------- */
// const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // APP_USR-... o TEST-...
// const APP_URL   = (process.env.APP_URL   || 'http://127.0.0.1:5500/src/pages').replace(/\/$/, '');
// const SERVER_URL= (process.env.MP_WEBHOOK_URL || process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');

// // Para evitar "auto_return invalid. back_url.success must be defined" en local,
// // lo hacemos opcional. Actívalo solo si usas HTTPS público (ngrok, etc).
// const MP_AUTO_RETURN = String(process.env.MP_AUTO_RETURN || '').toLowerCase();
// const WANT_AUTO_RETURN = MP_AUTO_RETURN === '1' || MP_AUTO_RETURN === 'true';

// // Si no hay token, detenemos la app para que sea claro el error de config.
// if (!MP_ACCESS_TOKEN) {
//   throw new Error('[MercadoPago] MP_ACCESS_TOKEN no configurado en .env');
// }

// // Cliente MP v2
// const mp = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// /**
//  * Crea una preferencia de pago (Checkout Pro).
//  * @param {Object} params
//  * @param {Array}  params.cart      [{ id, name, price, qty, image }]
//  * @param {Object} params.customer  { email, name, address, city, zip }
//  * @returns {Promise<{ ok:boolean, url?:string, id?:string, sandbox_url?:string, error?:string }>}
//  */
// async function createCheckoutPreference({ cart = [], customer = {} }) {
//   if (!Array.isArray(cart) || cart.length === 0) {
//     return { ok: false, error: 'carrito_vacio' };
//   }

//   // Mercado Pago espera precios en DECIMAL MXN (no centavos)
//   const items = cart.map((it) => ({
//     title: it.name || 'Producto',
//     quantity: Math.max(1, Number(it.qty || 1)),
//     currency_id: 'MXN',
//     unit_price: Number(it.price || 0),
//     picture_url: it.image || undefined,
//   }));

//   // back_urls
//   const backUrls = {
//     success: `${APP_URL}/home.html?success=1`,
//     failure: `${APP_URL}/home.html?failure=1`,
//     pending: `${APP_URL}/home.html?pending=1`,
//   };

//   // auto_return solo si estamos en HTTPS (recomendado por MP).
//   const isHttpsApp = /^https:\/\//i.test(APP_URL);
//   const useAutoReturn = WANT_AUTO_RETURN && isHttpsApp;

//   if (WANT_AUTO_RETURN && !isHttpsApp) {
//     console.warn('[MercadoPago] MP_AUTO_RETURN activo, pero APP_URL no es HTTPS. Omitiendo auto_return para evitar invalid_auto_return.');
//   }

//   try {
//     const prefApi = new Preference(mp);

//     const body = {
//       items,
//       payer: customer?.email
//         ? { email: customer.email, name: customer.name }
//         : undefined,
//       back_urls: backUrls,
//       // NOTA: no actives auto_return en local http://, solo con https:// público
//       ...(useAutoReturn ? { auto_return: 'approved' } : {}),
//       // Debe ser pública para recibir notificaciones reales (usa ngrok/Cloudflare Tunnel)
//       notification_url: `${SERVER_URL}/api/mp-webhook`,
//       statement_descriptor: 'VEMA CORP',
//       metadata: {
//         customerEmail: customer.email || '',
//         rawCart: JSON.stringify(cart || []),
//       },
//     };

//     const res = await prefApi.create({ body });

//     // SDK v2 devuelve { id, init_point, sandbox_init_point, ... }
//     return {
//       ok: true,
//       url: res.init_point,
//       sandbox_url: res.sandbox_init_point,
//       id: res.id,
//     };
//   } catch (err) {
//     console.error('MP preference error:', {
//       message: err?.message,
//       status: err?.status,
//       cause: err?.cause,
//       error: err?.error,
//     });
//     return { ok: false, error: 'mp_preference_error' };
//   }
// }

// module.exports = { createCheckoutPreference };
// s3