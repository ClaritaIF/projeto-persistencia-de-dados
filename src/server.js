import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabases, disconnectDatabases } from './db.js';
import { postgresThenMongo, mongoThenPostgres, updateBoth, snapshot, seed } from './coordinator.js';
import 'dotenv/config';

const app = express(); app.use(cors()); app.use(express.json());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.use(express.static(path.join(root, 'public')));
app.get('/api/state', async (_, res) => res.json(await snapshot()));
app.post('/api/scenarios/postgres-mongo', async (req, res) => res.json(await postgresThenMongo(req.body)));
app.post('/api/scenarios/mongo-postgres', async (req, res) => res.json(await mongoThenPostgres(req.body)));
app.post('/api/scenarios/update', async (_, res, next) => { try { res.json(await updateBoth()); } catch (e) { next(e); } });
app.use((err, _, res, __) => res.status(500).json({ error: err.message }));
const port = process.env.PORT || 3000;
connectDatabases().then(seed).then(() => app.listen(port, () => console.log(`2PC Lab: http://localhost:${port}`))).catch(error => { console.error(error); process.exit(1); });
process.on('SIGINT', () => disconnectDatabases().finally(() => process.exit()));
