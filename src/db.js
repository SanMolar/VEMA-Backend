
require('dotenv').config();
const { Pool } = require('pg');

// Usa .env o los literales mientras configuras
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'vema_victor',
  password: process.env.PGPASSWORD || 'molar12',
  database: process.env.PGDATABASE || 'vema_db',
});

module.exports = { pool };
