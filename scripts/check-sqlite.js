const { DatabaseSync: Database } = require('node:sqlite');
const db = new Database(':memory:');
try {
  const result = db.prepare('SELECT 1 AS ok').get();
  if (result.ok !== 1) throw new Error('Unexpected SQLite result');
  console.log('SQLite (node:sqlite) is working.');
} finally {
  db.close();
}
