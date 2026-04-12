const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: '0.0.0.0',
    user: 'zombie',
    password: 'andrei', 
    database: 'client'
  }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- Database Schema Setup ---
async function initDb() {
  try {
    // Users Table
    const hasUsers = await knex.schema.hasTable('users');
    if (!hasUsers) {
      await knex.schema.createTable('users', (table) => {
        table.increments('id').primary();
        table.string('email').unique().notNullable();
        table.string('password').notNullable(); 
      });
      console.log("Table 'users' created.");
    }

    // Clients Table
    const hasClients = await knex.schema.hasTable('clients');
    if (!hasClients) {
      await knex.schema.createTable('clients', (table) => {
        table.string('id', 36).primary();
        table.string('name').notNullable();
        table.integer('amount').notNullable();
      });
      console.log("Table 'clients' created.");
    }

    // Payments Table
    const hasPayments = await knex.schema.hasTable('payments');
    if (!hasPayments) {
      await knex.schema.createTable('payments', (table) => {
        table.increments('id').primary();
        table.string('clientId', 36).notNullable();
        table.string('month', 7).notNullable();
        table.unique(['clientId', 'month']);
        table.foreign('clientId').references('clients.id').onDelete('CASCADE');
      });
      console.log("Table 'payments' created.");
    }

    // --- ADDED: Commission Clients Table ---
    const hasCommClients = await knex.schema.hasTable('commission_clients');
    if (!hasCommClients) {
      await knex.schema.createTable('commission_clients', (table) => {
        table.string('id', 36).primary();
        table.string('name').notNullable();
      });
      console.log("Table 'commission_clients' created.");
    }

    // --- ADDED: Commission Projects Table ---
    const hasCommProjects = await knex.schema.hasTable('commission_projects');
    if (!hasCommProjects) {
      await knex.schema.createTable('commission_projects', (table) => {
        table.increments('id').primary();
        table.string('clientId', 36).notNullable();
        table.string('description').notNullable();
        table.foreign('clientId').references('commission_clients.id').onDelete('CASCADE');
      });
      console.log("Table 'commission_projects' created.");
    }

  } catch (err) {
    console.error("Database initialization failed:", err.message);
  }
}

initDb();

// --- Auth Route ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await knex('users').where({ email }).first();
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ message: "Login successful", userId: user.id });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// --- Existing Recurring API Routes ---
app.get('/api/clients', async (req, res) => {
  const clients = await knex('clients').select('*');
  res.json(clients);
});

app.post('/api/clients', async (req, res) => {
  const { name, amount } = req.body;
  const newClient = { id: crypto.randomUUID(), name, amount: parseInt(amount) };
  await knex('clients').insert(newClient);
  res.status(201).json(newClient);
});

app.delete('/api/clients/:id', async (req, res) => {
  await knex('clients').where({ id: req.params.id }).del();
  res.status(204).end();
});

app.get('/api/payments', async (req, res) => {
  const { year } = req.query;
  const payments = await knex('payments').where('month', 'like', `${year}-%`).select('clientId', 'month');
  const paymentMap = {};
  payments.forEach(p => {
    if (!paymentMap[p.month]) paymentMap[p.month] = {};
    paymentMap[p.month][p.clientId] = true;
  });
  res.json(paymentMap);
});

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

// --- ADDED: Commission API Routes ---

app.get('/api/commission-clients', async (req, res) => {
  try {
    const clients = await knex('commission_clients').select('*');
    const projects = await knex('commission_projects').select('*');

    const formattedData = clients.map(client => ({
      ...client,
      projects: projects
        .filter(p => p.clientId === client.id)
        .map(p => p.description)
    }));
    res.json(formattedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/commission-clients', async (req, res) => {
  const { name } = req.body;
  try {
    const newClient = { id: crypto.randomUUID(), name };
    await knex('commission_clients').insert(newClient);
    res.status(201).json({ ...newClient, projects: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/commission-clients/:id', async (req, res) => {
  try {
    await knex('commission_clients').where({ id: req.params.id }).del();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/commission-clients/:id/projects', async (req, res) => {
  const { id } = req.params;
  const { projects } = req.body;
  try {
    await knex.transaction(async (trx) => {
      await trx('commission_projects').where({ clientId: id }).del();
      if (projects && projects.length > 0) {
        const toInsert = projects.map(desc => ({ 
          clientId: id, 
          description: desc 
        }));
        await trx('commission_projects').insert(toInsert);
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Status and Listener ---
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'API is running'
  });
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));