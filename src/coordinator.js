import crypto from 'node:crypto';
import { pool, db, mongo } from './db.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const operations = [];
function newOperation(scenario) {
  const op = { id: crypto.randomUUID(), scenario, state: 'PREPARING', startedAt: new Date().toISOString(), steps: [] };
  operations.unshift(op); return op;
}
function step(op, phase, detail, status = 'ok') { op.steps.push({ at: new Date().toISOString(), phase, detail, status }); }
async function saveLog(op) {
  await pool.query('INSERT INTO operation_log (id,scenario,state,steps) VALUES ($1,$2,$3,$4)', [op.id, op.scenario, op.state, JSON.stringify(op.steps)]);
}

export function recentOperations() { return operations.slice(0, 15); }

export async function postgresThenMongo(input) {
  const op = newOperation('PostgreSQL → MongoDB (falha no MongoDB)');
  const customer = { id: crypto.randomUUID(), name: input.name, email: input.email, status: 'active', version: 1 };
  let pgInserted = false;
  try {
    step(op, 'PREPARE', 'Validação do payload e reserva do identificador global.');
    await pool.query('INSERT INTO customers (id,name,email,status,version) VALUES ($1,$2,$3,$4,$5)', Object.values(customer));
    pgInserted = true; step(op, 'PREPARE', 'PostgreSQL gravou a alteração pendente de confirmação.');
    step(op, 'COMMIT', 'Tentativa de persistência no MongoDB.', 'running');
    throw new Error('Falha induzida: MongoDB recusou a gravação.');
  } catch (error) {
    if (pgInserted) { await pool.query('DELETE FROM customers WHERE id=$1', [customer.id]); step(op, 'COMPENSATE', 'Rollback compensatório: registro removido do PostgreSQL.'); }
    op.state = 'ABORTED'; step(op, 'ABORT', error.message, 'error'); await saveLog(op); return op;
  }
}

export async function mongoThenPostgres(input) {
  const op = newOperation('MongoDB → PostgreSQL (falha no PostgreSQL)');
  const customer = { id: crypto.randomUUID(), name: input.name, email: input.email, status: 'active', version: 1 };
  let mongoInserted = false;
  try {
    step(op, 'PREPARE', 'Validação do payload e reserva do identificador global.');
    await db().collection('customers').insertOne({ ...customer, createdAt: new Date() });
    mongoInserted = true; step(op, 'PREPARE', 'MongoDB gravou o documento pendente de confirmação.');
    step(op, 'COMMIT', 'Tentativa de persistência no PostgreSQL.', 'running');
    throw new Error('Falha induzida: PostgreSQL recusou a gravação.');
  } catch (error) {
    if (mongoInserted) { await db().collection('customers').deleteOne({ id: customer.id }); step(op, 'COMPENSATE', 'Rollback compensatório: documento removido do MongoDB.'); }
    op.state = 'ABORTED'; step(op, 'ABORT', error.message, 'error'); await saveLog(op); return op;
  }
}

export async function seed() {
  const found = await pool.query('SELECT COUNT(*)::int AS count FROM customers');
  if (found.rows[0].count) return;
  const customer = { id: crypto.randomUUID(), name: 'Ana Martins', email: 'ana@exemplo.com', status: 'active', version: 1 };
  await pool.query('INSERT INTO customers (id,name,email,status,version) VALUES ($1,$2,$3,$4,$5)', Object.values(customer));
  await db().collection('customers').insertOne({ ...customer, createdAt: new Date() });
}

export async function updateBoth() {
  const op = newOperation('Atualização concorrente nos dois bancos');
  const row = (await pool.query('SELECT * FROM customers ORDER BY created_at LIMIT 1')).rows[0];
  if (!row) throw new Error('Não há dados para atualizar.');
  const next = row.status === 'active' ? 'reviewed' : 'active';
  step(op, 'PREPARE', `Versão ${row.version} lida; nova situação: ${next}.`);
  const pg = await pool.query('UPDATE customers SET status=$1, version=version+1 WHERE id=$2 AND version=$3', [next, row.id, row.version]);
  if (!pg.rowCount) throw new Error('Conflito de versão no PostgreSQL.');
  step(op, 'COMMIT', 'PostgreSQL atualizado com bloqueio otimista.');
  await sleep(80);
  const result = await db().collection('customers').updateOne({ id: row.id, version: row.version }, { $set: { status: next }, $inc: { version: 1 } });
  if (!result.modifiedCount) {
    await pool.query('UPDATE customers SET status=$1, version=version-1 WHERE id=$2', [row.status, row.id]);
    step(op, 'COMPENSATE', 'MongoDB não confirmou; atualização PostgreSQL desfeita.', 'error'); op.state = 'ABORTED';
  } else { step(op, 'COMMIT', 'MongoDB atualizado com bloqueio otimista.'); op.state = 'COMMITTED'; }
  await saveLog(op); return op;
}

export async function snapshot() {
  const [pgRows, mongoRows] = await Promise.all([
    pool.query('SELECT id,name,email,status,version,created_at FROM customers ORDER BY created_at DESC'),
    db().collection('customers').find({}, { projection: { _id: 0, createdAt: 0 } }).toArray()
  ]);
  return { postgres: pgRows.rows, mongo: mongoRows, operations: recentOperations(), observedAt: new Date().toISOString() };
}
