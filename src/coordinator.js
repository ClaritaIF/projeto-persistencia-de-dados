import crypto from 'node:crypto';
import { pool, db, mongo } from './db.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const activeOperations = new Map();
function newOperation(scenario) {
  const op = { id: crypto.randomUUID(), scenario, state: 'PREPARING', startedAt: new Date().toISOString(), steps: [] };
  activeOperations.set(op.id, op);
  return op;
}
function step(op, phase, detail, status = 'ok') { op.steps.push({ at: new Date().toISOString(), phase, detail, status }); }
async function saveLog(op) {
  await pool.query('INSERT INTO operation_log (id,scenario,state,steps,transaction_view) VALUES ($1,$2,$3,$4,$5)', [op.id, op.scenario, op.state, JSON.stringify(op.steps), JSON.stringify(op.transactionView || null)]);
  activeOperations.delete(op.id);
}

export async function postgresThenMongo(input) {
  const op = newOperation('PostgreSQL → MongoDB (falha no MongoDB)');
  const customer = { id: crypto.randomUUID(), name: input.name, email: input.email, status: 'active', version: 1 };
  const client = await pool.connect();
  try {
    step(op, 'PREPARE', 'Validação do payload e reserva do identificador global.');
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO customers (id,name,email,status,version) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,status,version,created_at', Object.values(customer));
    op.transactionView = {
      database: 'PostgreSQL',
      command: 'INSERT INTO customers (...) VALUES (...) RETURNING id, name, email, status, version, created_at;',
      readMethod: 'Resultado retornado pelo PostgreSQL na mesma transação aberta',
      record: inserted.rows[0]
    };
    step(op, 'PREPARE', 'PostgreSQL gravou a alteração dentro de uma transação aberta.');
    step(op, 'WAITING', 'Registro ainda está invisível para consultas externas: aguarda a decisão do coordenador.', 'running');
    await sleep(2400);
    step(op, 'COMMIT', 'Tentativa de persistência no MongoDB.', 'running');
    throw new Error('Falha induzida: MongoDB recusou a gravação.');
  } catch (error) {
    await client.query('ROLLBACK');
    step(op, 'ROLLBACK', 'Transação PostgreSQL desfeita; nenhum registro foi confirmado.');
    op.state = 'ABORTED'; step(op, 'ABORT', error.message, 'error'); await saveLog(op); return op;
  } finally { client.release(); }
}

export async function mongoThenPostgres(input) {
  const op = newOperation('MongoDB → PostgreSQL (falha no PostgreSQL)');
  const customer = { id: crypto.randomUUID(), name: input.name, email: input.email, status: 'active', version: 1 };
  const session = mongo.startSession();
  try {
    step(op, 'PREPARE', 'Validação do payload e reserva do identificador global.');
    session.startTransaction();
    const collection = db().collection('customers');
    await collection.insertOne({ ...customer, createdAt: new Date() }, { session });
    const inserted = await collection.findOne({ id: customer.id }, { session, projection: { _id: 0 } });
    op.transactionView = {
      database: 'MongoDB',
      command: 'db.customers.insertOne({...}, { session }); db.customers.findOne({ id }, { session });',
      readMethod: 'Documento lido pelo MongoDB na mesma sessão transacional',
      record: inserted
    };
    step(op, 'PREPARE', 'MongoDB gravou o documento em uma transação aberta.');
    step(op, 'WAITING', 'Documento ainda está invisível para consultas externas: aguarda a decisão do coordenador.', 'running');
    await sleep(2400);
    step(op, 'COMMIT', 'Tentativa de persistência no PostgreSQL.', 'running');
    throw new Error('Falha induzida: PostgreSQL recusou a gravação.');
  } catch (error) {
    await session.abortTransaction();
    step(op, 'ROLLBACK', 'Transação MongoDB abortada; nenhum documento foi confirmado.');
    op.state = 'ABORTED'; step(op, 'ABORT', error.message, 'error'); await saveLog(op); return op;
  } finally { await session.endSession(); }
}

export async function seed() {
  let rows = (await pool.query('SELECT id,name,email,status,version FROM customers')).rows;
  if (!rows.length) {
    const customer = { id: crypto.randomUUID(), name: 'Ana Martins', email: 'ana@exemplo.com', status: 'active', version: 1 };
    await pool.query('INSERT INTO customers (id,name,email,status,version) VALUES ($1,$2,$3,$4,$5)', Object.values(customer));
    rows = [customer];
  }
  await Promise.all(rows.map(customer => db().collection('customers').updateOne({ id: customer.id }, { $setOnInsert: { ...customer, createdAt: new Date() } }, { upsert: true })));
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
    const undo = await pool.query('UPDATE customers SET status=$1, version=version-1 WHERE id=$2 AND version=$3', [row.status, row.id, row.version + 1]);
    step(op, 'COMPENSATE', undo.rowCount ? 'MongoDB não confirmou; atualização PostgreSQL desfeita.' : 'MongoDB não confirmou; compensação PostgreSQL encontrou conflito.', undo.rowCount ? 'error' : 'warning'); op.state = 'ABORTED';
  } else { step(op, 'COMMIT', 'MongoDB atualizado com bloqueio otimista.'); op.state = 'COMMITTED'; }
  await saveLog(op); return op;
}

export async function snapshot() {
  const [pgRows, mongoRows, operationRows] = await Promise.all([
    pool.query('SELECT id,name,email,status,version,created_at FROM customers ORDER BY created_at DESC'),
    db().collection('customers').find({}, { projection: { _id: 0, createdAt: 0 } }).toArray(),
    pool.query('SELECT id,scenario,state,steps,transaction_view,created_at FROM operation_log ORDER BY created_at DESC LIMIT 15')
  ]);
  const completedOperations = operationRows.rows.map(row => ({ id: row.id, scenario: row.scenario, state: row.state, steps: row.steps, transactionView: row.transaction_view, startedAt: row.created_at }));
  const operations = [...activeOperations.values(), ...completedOperations].slice(0, 15);
  return { postgres: pgRows.rows, mongo: mongoRows, operations, observedAt: new Date().toISOString() };
}
