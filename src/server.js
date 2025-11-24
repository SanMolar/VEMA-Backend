require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');GIT 
const jwt     = require('jsonwebtoken');

// SDK Mercado Pago v2
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const { pool } = require('./db');
const { sendPurchaseConfirmation, verifyTransport } = require('./mailer');
const { priceCart } = require('./services/pricing');

const app = express(); 

/* -------------------- Config -------------------- */
const PORT = process.env.PORT || 3000;

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://127.0.0.1:5500', 'http://localhost:5500'];

const JWT_SECRET    = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES   = process.env.JWT_EXPIRES || '1d';
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

const trimEndSlash = (s) => String(s || '').trim().replace(/\/+$/, '');
const APP_BASE     = trimEndSlash(process.env.APP_URL    || 'http://127.0.0.1:5500/src/pages');
const SERVER_BASE  = trimEndSlash(process.env.SERVER_URL || `http://localhost:${PORT}`);
const isHttpUrl    = (u) => /^https?:\/\//i.test(u);

// (Opcional: valida URLs si quieres que el server no arranque con valores inválidos)
// if (!isHttpUrl(APP_BASE))   throw new Error('[ENV] APP_URL inválida');
// if (!isHttpUrl(SERVER_BASE)) throw new Error('[ENV] SERVER_URL inválida');

const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const mpClient = MP_TOKEN ? new MercadoPagoConfig({ accessToken: MP_TOKEN }) : null;

/* -------------------- Middlewares -------------- */
// CORS: permitir Netlify, localhost y túneles (ngrok) + previews *.netlify.app
const rawAllowed = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'https://vemacorp.netlify.app',
      'http://localhost:5173',     // Vite
      'http://127.0.0.1:5500',     // Live Server
      'http://localhost:5500'
    ];

const allowedRegex = [
  /^https?:\/\/[a-z0-9-]+\.ngrok(-free)?\.dev$/i, // ngrok
  /^https?:\/\/.*\.netlify\.app$/i                // previews/deploys Netlify
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/Postman
    if (rawAllowed.includes(origin) || allowedRegex.some(rx => rx.test(origin))) {
      return cb(null, true);
    }
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
  maxAge: 86400
};

app.use(cors(corsOptions));

// ⚠️ NO usar app.options('*', …) con Express 5.
// Preflight universal:
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    // CORS ya puso los headers, solo respondemos 204
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // para webhooks
/* -------------------- Helpers ------------------ */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function normalizeSector(s = '') {
  const x = String(s || '').trim().toLowerCase();
  if (['empresa','empresas','privada','privadas'].includes(x)) return 'empresa';
  if (['escuela','escuelas','edu','educacion','educación'].includes(x)) return 'escuela';
  if (['gobierno','gov','publico','público'].includes(x)) return 'gobierno';
  return 'general';
}

/* -------------------- Users API ---------------- */
const usersRouter = express.Router();

/** GET /api/users?page=1&limit=8&q=texto */
usersRouter.get('/users', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '8', 10)));
    const q     = String(req.query.q || '').trim();

    const where = [];
    const args  = [];
    if (q) { args.push(`%${q}%`); where.push(`email ILIKE $${args.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRes = await pool.query(`SELECT COUNT(*)::int AS total FROM public.users ${whereSql};`, args);
    const total = totalRes.rows[0]?.total ?? 0;

    args.push(limit, (page - 1) * limit);
    const dataRes = await pool.query(
      `SELECT id, email, role, status, sector, created_at
         FROM public.users
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length};`,
      // ojo: para evitar mutar "args" original, reconstruimos
      (where.length ? args.slice(0, -2) : []).concat([limit, (page - 1) * limit])
    );
    res.json({ data: dataRes.rows || [], total });
  } catch (err) {
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Lógica común para cambiar rol
async function updateUserRoleTx(id, role) {
  const sql = 'UPDATE public.users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, role';
  const { rows } = await pool.query(sql, [role, id]);
  return rows[0] || null;
}

/** PATCH /api/users/:id/role { role } */
usersRouter.patch('/users/:id/role', async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const role = String(req.body?.role || '').toUpperCase();
    if (!id || !['USER','MANAGER','ADMIN'].includes(role))
      return res.status(400).json({ error: 'params_invalid' });

    // Protección: no dejes 0 ADMIN
    if (role !== 'ADMIN') {
      const whoRes = await pool.query('SELECT role FROM public.users WHERE id = $1 LIMIT 1;', [id]);
      if (whoRes.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (whoRes.rows[0].role === 'ADMIN') {
        const adminsRes = await pool.query("SELECT COUNT(*)::int AS c FROM public.users WHERE role = 'ADMIN';");
        if ((adminsRes.rows[0]?.c ?? 0) <= 1)
          return res.status(409).json({ error: 'ultimo_admin' });
      }
    }

    const user = await updateUserRoleTx(id, role);
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, user });
  } catch (err) {
    console.error('PATCH /users/:id/role error:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

/** POST /api/users/role { id, role }  (para tu front) */
usersRouter.post('/users/role', async (req, res) => {
  try {
    const id   = Number(req.body?.id);
    const role = String(req.body?.role || '').toUpperCase();
    if (!id || !['USER','MANAGER','ADMIN'].includes(role))
      return res.status(400).json({ ok:false, error:'params_invalid' });

    // Misma protección de “último admin”
    if (role !== 'ADMIN') {
      const whoRes = await pool.query('SELECT role FROM public.users WHERE id = $1 LIMIT 1;', [id]);
      if (whoRes.rowCount === 0) return res.status(404).json({ ok:false, error:'not_found' });
      if (whoRes.rows[0].role === 'ADMIN') {
        const adminsRes = await pool.query("SELECT COUNT(*)::int AS c FROM public.users WHERE role = 'ADMIN';");
        if ((adminsRes.rows[0]?.c ?? 0) <= 1)
          return res.status(409).json({ ok:false, error:'ultimo_admin' });
      }
    }

    const user = await updateUserRoleTx(id, role);
    if (!user) return res.status(404).json({ ok:false, error:'not_found' });
    res.json({ ok:true, user });
  } catch (e) {
    console.error('POST /users/role error:', e);
    res.status(500).json({ ok:false, error:'db_error' });
  }
});

// Monta en /api y plano por compatibilidad
app.use('/api', usersRouter);
app.use(usersRouter);

/* -------------------- Health ------------------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/db-ping', async (_req, res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ db: 'ok', now: r.rows?.[0]?.now ?? null });
  } catch (err) {
    res.status(500).json({ db: 'error', message: err.message });
  }
});

/* -------------------- Auth --------------------- */
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, sector: rawSector } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, code: 'faltan_datos' });

    const r1 = await pool.query('SELECT id FROM public.users WHERE email = $1 LIMIT 1;', [email]);
    if (r1.rowCount > 0) return res.status(409).json({ ok: false, code: 'email_ya_registrado' });

    const allowed = new Set(['general','escuela','gobierno','empresa']);
    const sector  = allowed.has(String(rawSector).toLowerCase())
      ? String(rawSector).toLowerCase() : 'general';

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r2 = await pool.query(
      `INSERT INTO public.users (email, password_hash, sector)
       VALUES ($1, $2, $3)
       RETURNING id, email, sector, status, created_at;`,
      [email, password_hash, sector]
    );
    res.status(201).json({ ok: true, user: r2.rows[0] });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ ok: false, code: 'error_interno' });
  }
});

// Alias sin /api para compat
app.post('/login', (req, _res, next) => { req.url = '/api/login'; next(); });

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, code: 'faltan_datos' });

    const r1 = await pool.query(
      `SELECT id, email, password_hash, status, sector
         FROM public.users
        WHERE email = $1
        LIMIT 1;`,
      [email]
    );
    if (r1.rowCount === 0) return res.status(404).json({ ok: false, code: 'usuario_no_encontrado' });

    const user = r1.rows[0];
    if (user.status !== 'active') return res.status(403).json({ ok: false, code: 'usuario_inactivo' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, code: 'password_invalida' });

    const token = signToken({ uid: user.id, email: user.email, sector: user.sector });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, status: user.status, sector: user.sector } });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ ok: false, code: 'error_interno' });
  }
});

/* -------------------- Pricing (preview) -------- */
app.post('/api/pricing/preview', (req, res) => {
  try {
    const { cart, sector } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ ok: false, error: 'carrito_vacio' });
    }
    const pricing = priceCart(cart, normalizeSector(sector));
    res.json({ ok: true, pricing });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ------------- Checkout MP --------- */
app.post('/api/checkout-mp', async (req, res) => {
  try {
    if (!mpClient) return res.status(500).json({ ok: false, error: 'MP_token_faltante' });

    const { customer, cart, sector } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ ok: false, error: 'carrito_vacio' });
    }

    const normalizedSector = normalizeSector(sector);
    const pricing = priceCart(cart, normalizedSector);

    const SEND_MP_WITH_IVA = (process.env.MP_PRICES_WITH_IVA ?? 'false').toLowerCase() === 'true';
    const mpItems = pricing.items.map((it) => {
      const unitNet = Number(it.unit_net);
      const unitWithIva = Number((unitNet * (1 + pricing.iva.rate)).toFixed(2));
      return {
        title: it.name, quantity: it.qty, currency_id: 'MXN',
        unit_price: SEND_MP_WITH_IVA ? unitWithIva : unitNet,
        picture_url: it.image,
      };
    });

    const successUrl = `${APP_BASE}/home.html?success=1`;
    const failureUrl = `${APP_BASE}/home.html?failure=1`;
    const pendingUrl = `${APP_BASE}/home.html?pending=1`;
    if (!isHttpUrl(successUrl) || !isHttpUrl(failureUrl) || !isHttpUrl(pendingUrl)) {
      return res.status(500).json({ ok: false, error: 'back_urls_invalid' });
    }

    const isHttpsApp = /^https:\/\//i.test(APP_BASE);
    const body = {
      items: mpItems,
      payer: { email: customer?.email || undefined, name: customer?.name || undefined },
      back_urls: { success: successUrl, failure: failureUrl, pending: pendingUrl },
      ...(isHttpsApp ? { auto_return: 'approved' } : {}),
      notification_url: `${SERVER_BASE}/api/mp-webhook`,
      metadata: {
        sector: pricing.sector,
        cart: JSON.stringify(cart || []),
        totals: JSON.stringify(pricing.totals),
        name: customer?.name || '',
      },
      statement_descriptor: 'VEMA CORP',
    };

    const preference = new Preference(mpClient);
    const pref = await preference.create({ body });

    const isSandbox = (process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-');
    res.json({ ok: true, url: isSandbox ? pref.sandbox_init_point : pref.init_point, id: pref.id, pricing });
  } catch (err) {
    console.error('checkout-mp error:', { message: err.message, status: err?.status, cause: err?.cause, error: err?.error });
    res.status(500).json({ ok: false, error: 'checkout_mp_fallo' });
  }
});

/* ----------------- Webhook MP ------------------ */
app.post('/api/mp-webhook', async (req, res) => {
  try {
    const type = req.body.type || req.query.type || req.body.topic || req.query.topic;
    const data = req.body.data || {};
    const idQS = req.query.id || req.body['data.id'] || data.id;

    if ((type === 'payment' || type === 'merchant_order') && idQS) {
      if (!mpClient) return res.sendStatus(200);
      const paymentClient = new Payment(mpClient);
      const payment = await paymentClient.get({ id: idQS.toString() });

      const email  = payment?.payer?.email || payment?.additional_info?.payer?.email || '';
      const amount = payment?.transaction_amount;
      const status = payment?.status;

      if (email && status === 'approved') {
        await sendPurchaseConfirmation({
          to: email,
          amountCents: Math.round(Number(amount) * 100),
          items: [],
          orderId: idQS,
        });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('mp-webhook error:', err.message);
    res.sendStatus(200);
  }
});

/* -------------------- Listen ------------------- */
app.listen(PORT, async () => {
  console.log(`API escuchando en ${SERVER_BASE}`);
  try {
    const r = await pool.query('SELECT 1 AS ok');
    console.log('Conexión a BD OK:', r.rows?.[0]);
  } catch (err) {
    console.error('Error conexión BD al iniciar:', err.message);
  }
  verifyTransport?.(); // si tu mailer lo exporta
});
