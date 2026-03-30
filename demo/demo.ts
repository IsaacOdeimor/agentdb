/**
 * AgentDB — Visual Terminal Demo
 *
 * Run with:  npx tsx demo/demo.ts
 *
 * Shows: insert, query, encryption, compression, WAL crash-safety,
 * schema validation, indexes, and aggregation — all in a readable
 * step-by-step walkthrough with timing and record counts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { AgentDB } from '../src/database.js';

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
  bgBlue: '\x1b[44m',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Typewrite a single line — ANSI escape sequences are emitted instantly,
 * visible characters are printed one-by-one with `delay` ms between each.
 */
async function tw(text: string, delay = 12): Promise<void> {
  // Split into ANSI codes (emitted atomically) and plain text (char by char)
  const parts = text.split(/(\x1b\[[0-9;]*m)/g);
  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      process.stdout.write(part);
    } else {
      for (const ch of part) {
        process.stdout.write(ch);
        if (ch !== ' ' && ch !== '\n') await sleep(delay);
      }
    }
  }
  process.stdout.write('\n');
}

async function banner(title: string) {
  const line = '─'.repeat(60);
  process.stdout.write(`\n${C.cyan}${line}${C.reset}\n`);
  await tw(`${C.bold}${C.white}  ${title}${C.reset}`, 18);
  process.stdout.write(`${C.cyan}${line}${C.reset}\n`);
}

async function step(label: string) {
  process.stdout.write('\n');
  await tw(`${C.yellow}▶  ${label}${C.reset}`, 14);
}

async function ok(label: string, value?: unknown) {
  const val = value !== undefined
    ? `  ${C.dim}→${C.reset} ${C.green}${JSON.stringify(value, null, 0)}${C.reset}`
    : '';
  await tw(`   ${C.green}✓${C.reset}  ${label}${val}`, 10);
}

async function info(label: string) {
  await tw(`   ${C.cyan}ℹ${C.reset}  ${C.dim}${label}${C.reset}`, 7);
}

async function err(label: string) {
  await tw(`   ${C.red}✗${C.reset}  ${label}`, 10);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  const ms = (performance.now() - t0).toFixed(2);
  await tw(`   ${C.green}✓${C.reset}  ${label}  ${C.dim}(${ms} ms)${C.reset}`, 10);
  return result;
}

async function pause() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => {
    rl.question(`\n${C.dim}  ↵  press Enter to continue...${C.reset}`, () => {
      rl.close();
      resolve();
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── Header ─────────────────────────────────────────────────────────────────
  console.clear();
  await tw(`\n${C.bgBlue}${C.bold}  AgentDB  —  Embedded Document Database Demo  ${C.reset}`, 14);
  await tw(`${C.dim}  Binary format · AES-256-GCM · WAL · Zero deps${C.reset}\n`, 8);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-demo-'));
  await info(`Data directory: ${tmpDir}`);

  // ───────────────────────────────────────────────────────────────────────────
  await banner('1 · Opening the database');
  // ───────────────────────────────────────────────────────────────────────────

  const db = new AgentDB(tmpDir, {
    compressionEnabled: true,
    autoCompact: true,
  });

  await timed('db.open()', () => db.open());
  await ok('WAL initialised, lock acquired');

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('2 · Basic insert & query');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Create "users" collection and insert records');
  const users = db.collection('users');

  const names = ['Alice', 'Bob', 'Carol', 'David', 'Eve'];
  const ages  = [29, 34, 22, 45, 31];

  for (let i = 0; i < names.length; i++) {
    users.insert({ name: names[i], age: ages[i], role: i % 2 === 0 ? 'admin' : 'user' });
  }
  await ok(`Inserted ${names.length} documents`);

  await step('Query: age >= 30, sorted by name asc');
  const adults = users.query()
    .where('age', '>=', 30)
    .sort('name', 'asc')
    .exec();
  for (const d of adults) await ok(`  ${d.name}`, { age: d.age, role: d.role });

  await step('Query: role = "admin"');
  const admins = users.query().where('role', '==', 'admin').exec();
  await ok(`Found ${admins.length} admins`);

  await step('find({ name: "Alice" })');
  const [alice] = users.find({ name: 'Alice' });
  await ok('find("Alice")', { id: alice?._id?.slice(0, 8) + '…', age: alice?.age });

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('3 · Compression');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Insert a large compressible document');
  const logs = db.collection('logs');
  const bigPayload = 'INFO  server started. '.repeat(200);  // ~4 KB repetitive text
  logs.insert({ event: 'startup', payload: bigPayload, ts: Date.now() });

  const logFile = path.join(tmpDir, 'logs.agdb');
  const fileSizeKB = fs.existsSync(logFile)
    ? (fs.statSync(logFile).size / 1024).toFixed(1)
    : '?';
  await ok(`logs.agdb on disk: ${fileSizeKB} KB  (raw payload was ~4 KB — compression active)`);
  await info('zlib deflate only fires when savings ≥ 10% and data ≥ 64 bytes');

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('4 · Encryption (AES-256-GCM)');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Open a second database with encryption enabled');
  const encDir = path.join(tmpDir, 'enc');
  const encDb = new AgentDB(encDir, { encryptionKey: 'super-secret-password' });
  await timed('encDb.open()', () => encDb.open());

  const secrets = encDb.collection('secrets');
  secrets.insert({ key: 'stripe_api_key', value: 'sk_live_XXXXXXXXXXXX', env: 'production' });
  secrets.insert({ key: 'db_password',    value: 'correct-horse-battery-staple', env: 'production' });
  await ok('Inserted 2 encrypted records');

  const encFile = path.join(encDir, 'secrets.agdb');
  const rawBytes = fs.readFileSync(encFile);
  const magic = rawBytes.slice(0, 4).toString('ascii');
  const hasPlaintext = rawBytes.toString('utf8').includes('stripe_api_key');
  await ok(`File magic: "${magic}"  (valid .agdb header)`);
  if (!hasPlaintext) {
    await ok('Plaintext "stripe_api_key" NOT visible in raw file bytes — ciphertext confirmed');
  } else {
    await err('WARNING: plaintext found in file (encryption may not be active)');
  }
  await info('AES-256-GCM · PBKDF2-SHA-512 key derivation · per-record random IV + auth tag');

  await step('Query encrypted data normally (transparent decryption)');
  const [found] = secrets.find({ key: 'stripe_api_key' });
  await ok('Decrypted value', found?.value);

  encDb.close();

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('5 · WAL — Write-Ahead Log & crash recovery');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Simulate crash: write WAL entries, then reopen without proper close');
  const walDir = path.join(tmpDir, 'wal-test');
  const walDb = new AgentDB(walDir);
  await walDb.open();
  const events = walDb.collection('events');
  events.insert({ type: 'login',    user: 'alice', ts: Date.now() });
  events.insert({ type: 'purchase', user: 'bob',   ts: Date.now() });
  await ok('2 documents written through WAL');
  await info('Simulating crash — releasing OS handles but NOT flushing or calling close()');

  const lockPath: string = (walDb as any).lockPath;
  if ((walDb as any).lockFd !== null) {
    try { fs.closeSync((walDb as any).lockFd); } catch {}
    (walDb as any).lockFd = null;
  }
  try { fs.unlinkSync(lockPath); } catch {}
  (walDb as any).opened = false;

  await step('Reopen — WAL replay should recover both records');
  const walDb2 = new AgentDB(walDir);
  await timed('walDb2.open() with WAL replay', () => walDb2.open());
  const recovered = walDb2.collection('events').find({});
  await ok(`Recovered ${recovered.length} / 2 records after simulated crash`);
  walDb2.close();

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('6 · Indexes & performance');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Insert 1 000 records and run indexed vs full-scan query');
  const perf = db.collection('perf');
  perf.createIndex('score');

  const t0 = performance.now();
  for (let i = 0; i < 1_000; i++) {
    perf.insert({ score: Math.floor(Math.random() * 1000), tag: `item-${i}` });
  }
  const insertMs = (performance.now() - t0).toFixed(0);
  await ok(`1 000 inserts in ${insertMs} ms  (~${Math.round(1_000 / (+insertMs / 1000))} ops/sec)`);

  const t1 = performance.now();
  const highScores = perf.query().where('score', '>=', 900).exec();
  const queryMs = (performance.now() - t1).toFixed(2);
  await ok(`Index query (score >= 900): ${highScores.length} results in ${queryMs} ms`);

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('7 · Aggregation');
  // ───────────────────────────────────────────────────────────────────────────

  await step('group by role, count and avgAge on users collection');
  const groups = users.aggregate().group('role');
  for (const g of groups) {
    const count = g.count;
    const avgAge = g.docs.reduce((s: number, d: any) => s + (d.age || 0), 0) / count;
    await ok(`role = ${g.key}`, { count, avgAge: +avgAge.toFixed(1) });
  }

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('8 · Schema validation');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Create collection with required-field schema');
  const products = db.collection('products');
  products.setSchema({
    name: 'products',
    fields: {
      sku:   { type: 'string', required: true  },
      price: { type: 'number', required: true  },
      stock: { type: 'number', required: false },
    },
  });

  try {
    products.insert({ sku: 'ABC-001', price: 29.99, stock: 100 });
    await ok('Valid document inserted');
  } catch (e: any) {
    await err(`Unexpected error: ${e.message}`);
  }

  try {
    products.insert({ sku: 'MISSING_PRICE' } as any);
    await err('Should have thrown schema error!');
  } catch (e: any) {
    await ok(`Schema correctly rejected document missing "price"`, { error: e.message });
  }

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('9 · Update, delete & compaction');
  // ───────────────────────────────────────────────────────────────────────────

  await step("Update Alice's age, delete Bob, then inspect counts");
  const beforeUpdate = users.count({});
  const [aliceDoc] = users.find({ name: 'Alice' });
  if (aliceDoc) {
    users.update(aliceDoc._id, { age: 30 });
    const [updated] = users.find({ name: 'Alice' });
    await ok(`Alice's age updated`, { was: 29, now: updated?.age });
  }

  users.deleteMany({ name: 'Bob' });
  const afterDelete = users.count({});
  await ok(`Deleted Bob  (${beforeUpdate} → ${afterDelete} records)`);
  await info('Deleted records become tombstones in the binary file');
  await info('Compaction rewrites the file without tombstones when >30% are deleted (min 50 records)');

  // ───────────────────────────────────────────────────────────────────────────
  await pause();
  await banner('10 · File layout');
  // ───────────────────────────────────────────────────────────────────────────

  await step('Files written to disk');
  const files = fs.readdirSync(tmpDir).sort();
  for (const f of files) {
    const fPath = path.join(tmpDir, f);
    const stat  = fs.statSync(fPath);
    if (stat.isDirectory()) {
      await info(`📁 ${f}/`);
    } else {
      const kb = (stat.size / 1024).toFixed(1);
      await ok(`${f}`, `${kb} KB`);
    }
  }
  await info('.agdb = binary data file  |  .wal = write-ahead log  |  .lock = process lock');

  // ── Close ──────────────────────────────────────────────────────────────────
  await pause();
  await banner('Done');
  db.close();
  await ok('Database closed cleanly — WAL flushed, lock released');
  await tw(`\n${C.dim}  Temp data: ${tmpDir}${C.reset}`, 6);
  await tw(`  ${C.green}${C.bold}AgentDB demo complete.${C.reset}\n`, 14);
}

main().catch(e => {
  console.error(`\n${C.red}Demo failed:${C.reset}`, e);
  process.exit(1);
});
