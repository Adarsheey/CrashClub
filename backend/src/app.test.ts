import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from './app.js';

test('health endpoint reports API and database ready', async () => {
  let query = '';
  const app = createApp({
    $queryRawUnsafe: async (sql) => { query = sql; return [{ '?column?': 1 }]; },
  });
  const response = await request(app).get('/api/health');
  assert.equal(query, 'SELECT 1');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'ok' });
});

test('health endpoint returns a safe unavailable response when the database fails', async () => {
  const app = createApp({ $queryRawUnsafe: async () => { throw new Error('private connection detail'); } });
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { status: 'error', database: 'unavailable' });
  assert.equal(JSON.stringify(response.body).includes('private connection detail'), false);
});

test('unknown API paths return JSON 404', async () => {
  const app = createApp({ $queryRawUnsafe: async () => [] });
  const response = await request(app).get('/api/no-such-route');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'Not found' });
});
