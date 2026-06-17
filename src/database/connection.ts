import knex, { Knex } from 'knex';
import knexConfig from './knexfile';

let db: Knex;

export function getDb(): Knex {
  if (!db) {
    db = knex(knexConfig);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
  }
}
