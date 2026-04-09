const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: '127.0.0.1',
    user: 'root',
    password: '', // Default XAMPP password is empty
    database: 'rr_management'
  }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- Database Schema Setup ---
async function initDb() {
  try {
    const hasClients = await knex.schema.hasTable('clients');
    if (!hasClients) {
      await knex.schema.createTable('clients', (table) => {
        table.string('id', 36).primary(); // UUIDs stored as strings
        table.string('name').notNullable();
        table.integer('amount').notNullable();
      });
      console.log("Table 'clients' created.");
    }

    const hasPayments = await knex.schema.hasTable('payments');
    if (!hasPayments) {
      await knex.schema.createTable('payments', (table) => {
        table.increments('id').primary();
        table.string('clientId', 36).notNullable();
        table.string('month', 7).notNullable(); // e.g., "2026-04"
        table.unique(['clientId', 'month']);
        
        table.foreign('clientId').references('clients.id').onDelete('CASCADE');
      });
      console.log("Table 'payments' created.");
    }
  } catch (err) {
    console.error("Database initialization failed:", err.message);
  }
}

initDb();

// --- API Routes ---

// Get all clients
app.get('/api/clients', async (req, res) => {
  const clients = await knex('clients').select('*');
  res.json(clients);
});

// Add a client
app.post('/api/clients', async (req, res) => {
  const { name, amount } = req.body;
  const newClient = { 
    id: crypto.randomUUID(), 
    name, 
    amount: parseInt(amount) 
  };
  await knex('clients').insert(newClient);
  res.status(201).json(newClient);
});

// Delete a client
app.delete('/api/clients/:id', async (req, res) => {
  await knex('clients').where({ id: req.params.id }).del();
  res.status(204).end();
});

// Get payments for specific year
app.get('/api/payments', async (req, res) => {
  const { year } = req.query;
  const payments = await knex('payments')
    .where('month', 'like', `${year}-%`)
    .select('clientId', 'month');

  // Convert to nested object for the frontend
  const paymentMap = {};
  payments.forEach(p => {
    if (!paymentMap[p.month]) paymentMap[p.month] = {};
    paymentMap[p.month][p.clientId] = true;
  });
  res.json(paymentMap);
});

// Toggle payment status
app.post('/api/payments/toggle', async (req, res) => {
  const { clientId, month } = req.body;
  const existing = await knex('payments').where({ clientId, month }).first();

  if (existing) {
    await knex('payments').where({ clientId, month }).del();
    res.json({ paid: false });
  } else {
    await knex('payments').insert({ clientId, month });
    res.json({ paid: true });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));