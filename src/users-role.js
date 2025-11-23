const express = require('express');
const { pool } = require('./db'); // ajusta la ruta si tu db.js está en otro lado
const router = express.Router();

router.post('/users/role', async (req, res) => {
  try {
    const id   = Number(req.body.id);                 // asegura número
    const role = String(req.body.role || '').toUpperCase();

    if (!id || !['USER','ADMIN'].includes(role)) {
      return res.status(400).json({ ok:false, error:'Parámetros inválidos' });
    }

    const sql = 'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role';
    const { rows } = await pool.query(sql, [role, id]);
    if (!rows.length) return res.status(404).json({ ok:false, error:'Usuario no encontrado' });

    return res.json({ ok:true, user: rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'Error interno' });
  }
});

module.exports = router;
