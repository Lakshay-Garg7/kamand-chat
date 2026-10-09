const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync: Database } = require('node:sqlite');

test('SQLite opens a database and runs a parameterized query', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO smoke_test (value) VALUES (?)').run('ready');
    const row = db.prepare('SELECT id, value FROM smoke_test WHERE id = ?').get(insert.lastInsertRowid);
    assert.deepEqual({ ...row }, { id: 1, value: 'ready' }); // node:sqlite rows have a null prototype
  } finally {
    db.close();
  }
});
