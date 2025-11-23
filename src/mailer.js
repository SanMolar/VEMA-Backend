// src/mailer.js
require('dotenv').config();
const nodemailer = require('nodemailer');

let transporter;
let usingEthereal = false;

async function buildTransport() {
  // Si el host es “placeholder” o no está, usamos Ethereal automáticamente
  const host = process.env.SMTP_HOST;
  if (!host || /tu-proveedor\.com/i.test(host)) {
    const test = await nodemailer.createTestAccount(); // crea cuenta temporal
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: test.user, pass: test.pass },
    });
    usingEthereal = true;
    console.log('SMTP DEV: usando Ethereal (solo pruebas).');
    return;
  }

  // SMTP real
  transporter = nodemailer.createTransport({
    host: host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function verifyTransport() {
  try {
    if (!transporter) await buildTransport();
    await transporter.verify();
    console.log('SMTP OK');
  } catch (e) {
    console.error('SMTP ERROR:', e.message);
  }
}

async function sendPurchaseConfirmation({ to, amountCents, items = [], orderId = null }) {
  if (!transporter) await buildTransport();

  const amount = (amountCents / 100).toFixed(2);
  const lines = items.map(i => `- ${i.name || i.id} x${i.qty} — $${i.price} MXN`).join('<br>');

  const html = `
    <h2>Compra confirmada</h2>
    <p>Gracias por tu compra.</p>
    ${orderId ? `<p>Folio: <b>${orderId}</b></p>` : ''}
    <p>Total: <b>$${amount} MXN</b></p>
    <div>${lines}</div>
  `;

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || '"VEMA" <no-reply@vema.com>',
    to,
    subject: 'Confirmación de compra',
    html,
  });

  if (usingEthereal) {
    const url = nodemailer.getTestMessageUrl(info);
    console.log('Vista del correo (Ethereal):', url);
  }
}

module.exports = { sendPurchaseConfirmation, verifyTransport };
