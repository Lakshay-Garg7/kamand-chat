const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectDir = path.resolve(__dirname, '..');
const examplePath = path.join(projectDir, '.env.example');
const envPath = path.join(projectDir, '.env');

if (fs.existsSync(envPath)) {
  console.log('.env already exists; leaving it unchanged.');
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error('Could not find .env.example. Run this command from the project folder.');
  process.exit(1);
}

const secret = crypto.randomBytes(48).toString('hex');
const example = fs.readFileSync(examplePath, 'utf8');
const output = example.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
if (output === example && !/^JWT_SECRET=/m.test(example)) {
  console.error('.env.example is missing the JWT_SECRET entry.');
  process.exit(1);
}
fs.writeFileSync(envPath, output, { flag: 'wx', mode: 0o600 });
console.log('Created .env with a random JWT_SECRET. The secret was not displayed.');
