import pg from 'pg';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
export const mongo = new MongoClient(process.env.MONGO_URL);
export const db = () => mongo.db(process.env.MONGO_DB || 'two_phase_lab');

export async function connectDatabases() {
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS operation_log (
    id UUID PRIMARY KEY, scenario TEXT NOT NULL, state TEXT NOT NULL, steps JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await mongo.connect();
  await db().collection('customers').createIndex({ id: 1 }, { unique: true });
}

export async function disconnectDatabases() { await mongo.close(); await pool.end(); }
