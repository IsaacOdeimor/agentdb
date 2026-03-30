<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/IsaacOdeimor/agentdb/main/demo/banner.svg">
  <img src="https://raw.githubusercontent.com/IsaacOdeimor/agentdb/main/demo/banner.svg" alt="AgentDB" width="100%">
</picture>

<br/>

[![License](https://img.shields.io/badge/License-Apache_2.0-7c3aed?style=for-the-badge)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/Tests-170_passing-22c55e?style=for-the-badge&logo=vitest&logoColor=white)](./tests)
[![Zero Deps](https://img.shields.io/badge/Dependencies-Zero-f97316?style=for-the-badge)](./package.json)

<br/>

<p>
  <a href="#quick-start">Get Started</a> ·
  <a href="#-storage--performance">Features</a> ·
  <a href="#query-builder">API Docs</a> ·
  <a href="#demo">Demo</a>
</p>

</div>

---

## What is AgentDB?

AgentDB is a **self-contained database** that lives inside your Node.js project. There is no server to install, no Docker container to run, no cloud account to set up. You point it at a folder, and it works — storing your data in efficient binary files right on disk.

> Think of it like SQLite, but for JSON documents — with encryption built in from day one.

> **Not a developer?** AgentDB is the storage engine powering apps and tools built on top of it. If someone told you to "set it up", jump to [Quick Start](#quick-start) — it takes about 60 seconds.

<br/>

<details>
<summary><b>⚡ Storage & Performance</b> — click to expand</summary>
<br/>

| Feature | Detail |
|---|---|
| **Binary `.agdb` format** | Compact on-disk storage with a 32-byte header and per-record CRC32 checksums |
| **Field indexes** | Binary search O(log n) lookups — dramatically faster queries on large collections |
| **Smart compression** | zlib per-record compression, only activates when savings ≥ 10% and data ≥ 64 bytes |
| **Auto compaction** | Rewrites files without tombstones when deleted records exceed 30% |
| **Streaming cursors** | Iterate over huge result sets without loading everything into memory |

</details>

<details>
<summary><b>🔐 Security & Crash Safety</b> — click to expand</summary>
<br/>

| Feature | Detail |
|---|---|
| **AES-256-GCM encryption** | Every record encrypted individually — PBKDF2-SHA-512 key derivation, random IV per record, auth tag |
| **Write-Ahead Log (WAL)** | Every write is journalled first — full automatic crash recovery on next open |
| **CRC32 checksums** | Per-record integrity verification — detects any corruption on read |
| **Process lock** | Prevents two processes from opening the same database simultaneously |

</details>

<details>
<summary><b>📊 Querying & Aggregation</b> — click to expand</summary>
<br/>

| Feature | Detail |
|---|---|
| **Chainable query builder** | `.where()` `.sort()` `.limit()` `.skip()` `.select()` `.first()` `.exists()` `.count()` |
| **Aggregation pipeline** | `group` `groupWith` `sum` `avg` `min` `max` `count` `distinct` `percentile` |
| **Full-text search** | Token-scored search across multiple fields |
| **Operators** | `==` `!=` `>` `>=` `<` `<=` |

</details>

<details>
<summary><b>🛡️ Data Integrity & Lifecycle</b> — click to expand</summary>
<br/>

| Feature | Detail |
|---|---|
| **Schema validation** | Enforce field types, required fields, min/max, enums, regex patterns, custom validators |
| **TTL auto-expiry** | Documents expire automatically — per-collection default or per-document override |
| **Events** | Subscribe to `insert` `update` `delete` `compact` on any collection |
| **Backup & restore** | Point-in-time snapshots with atomic restore and configurable max backups |
| **Version migrations** | Numbered migration steps that run in order on file upgrade |
| **Upsert / replace** | Merge updates or full document replacement |

</details>

<br/>

### Why AgentDB over the alternatives?

| | AgentDB | SQLite | MongoDB | Plain JSON |
|---|:---:|:---:|:---:|:---:|
| Zero dependencies | ✅ | ❌ native binding | ❌ server required | ✅ |
| Encrypted at rest | ✅ built-in | ❌ | ✅ paid tier | ❌ |
| Crash safe | ✅ WAL | ✅ | ✅ | ❌ |
| Document model | ✅ | ❌ rows only | ✅ | ✅ |
| Binary format | ✅ compact | ✅ | ✅ | ❌ bloated |
| Field indexes | ✅ | ✅ | ✅ | ❌ |
| Full TypeScript | ✅ | partial | partial | ✅ |

---

## Quick Start

### Install

Clone the repo and install dependencies:

```bash
git clone https://github.com/IsaacOdeimor/agentdb.git
cd agentdb
npm install
```

> **npm package coming soon.** AgentDB will be published to npm shortly. For now, clone the repo and import directly from `src/`.

### Basic usage

```typescript
import { AgentDB } from './src/database.js';

// 1. Open (or create) a database
const db = new AgentDB('./my-data');
await db.open();

// 2. Get a collection (like a table)
const users = db.collection('users');

// 3. Insert documents
users.insert({ name: 'Alice', age: 29, role: 'admin' });
users.insert({ name: 'Bob',   age: 34, role: 'user'  });

// 4. Query
const admins = users.query()
  .where('age', '>=', 18)
  .where('role', '==', 'admin')
  .sort('name', 'asc')
  .exec();

console.log(admins); // [{ _id: '...', name: 'Alice', age: 29, role: 'admin', _ts: ... }]

// 5. Close when done
db.close();
```

### What gets written to disk

```
my-data/
├── users.agdb          ← binary document file
├── users.wal           ← write-ahead log (crash recovery)
└── .agentdb.lock       ← process lock (prevents double-open)
```

---

## Database Options

```typescript
const db = new AgentDB('./data', {
  compressionEnabled: true,   // compress all records by default
  encryptionKey: 'password',  // encrypt all data with AES-256-GCM
  autoCompact: true,          // compact files when tombstones exceed 30%
  compactThreshold: 0.3,      // tombstone ratio that triggers compaction
  maxBackups: 5,              // keep at most N automatic backups
  backupOnOpen: true,         // snapshot the DB every time it opens
});

await db.open();
```

---

## Collections

A **collection** is a named bucket of documents — like a table in SQL, or a collection in MongoDB.

```typescript
// Get or create a collection (sync — safe after open())
const posts = db.collection('posts');

// Async version — explicit guarantee before first insert
const posts = await db.getCollection('posts');

// With options
const logs = db.collection('logs', {
  compression: true,    // compress records in this collection
  ttl: 7 * 86400_000,   // documents expire after 7 days
  maxDocs: 10_000,      // refuse inserts beyond this count
});
```

---

## CRUD Operations

### Insert

```typescript
// Insert one — returns the auto-generated _id
const id = users.insert({ name: 'Carol', age: 22 });

// Insert with a custom _id
users.insert({ _id: 'user-carol', name: 'Carol', age: 22 });

// Insert many
users.insertMany([
  { name: 'Dave', age: 40 },
  { name: 'Eve',  age: 31 },
]);
```

### Find

```typescript
// Find all
users.find();

// Find by exact field values
users.find({ role: 'admin' });

// Find by ID
users.findById('abc123');

// Count
users.count();
users.count({ role: 'admin' });
```

### Update

```typescript
// Update by ID — merges changes (existing fields not in updates are kept)
users.update('abc123', { age: 30 });

// Replace by ID — replaces the entire document
users.replace('abc123', { name: 'Alice', age: 30, role: 'admin' });

// Upsert — insert if not found, update if found
users.upsert('user-alice', { name: 'Alice', age: 30 });
```

### Delete

```typescript
// Delete by ID
users.delete('abc123');

// Delete all matching a filter
users.deleteMany({ role: 'guest' });

// Delete all documents in the collection
users.clear();
```

---

## Query Builder

The query builder lets you filter, sort, page, and project results in a readable chain.

```typescript
const results = users.query()
  .where('age',  '>=', 18)       // filter: age >= 18
  .where('role', '==', 'admin')  // filter: role == "admin"
  .sort('name', 'asc')           // sort A → Z
  .skip(20)                      // skip first 20
  .limit(10)                     // take next 10
  .select('name', 'age')         // only return these fields
  .exec();                       // run it
```

### Available operators

| Operator | Meaning |
|---|---|
| `==` | equals |
| `!=` | not equals |
| `>` | greater than |
| `>=` | greater than or equal |
| `<` | less than |
| `<=` | less than or equal |

### Other query methods

```typescript
// Get only the first result (or null)
const user = users.query().where('name', '==', 'Alice').first();

// Check if any match exists
const exists = users.query().where('email', '==', 'alice@x.com').exists();

// Count matches
const n = users.query().where('role', '==', 'admin').count();

// Stream results with a cursor
const cursor = users.query().where('age', '>=', 18).cursor();
while (cursor.hasNext()) {
  const doc = cursor.next();
}
```

---

## Aggregation

Run analytics over your data with a pipeline-style API.

```typescript
// Group by a field and count
const byRole = users.aggregate()
  .group('role');
// → [{ key: 'admin', count: 3, docs: [...] }, { key: 'user', count: 2, docs: [...] }]

// Group with computed metrics
const stats = users.aggregate()
  .groupWith('role', {
    total:  { op: 'count' },
    avgAge: { op: 'avg',  field: 'age' },
    maxAge: { op: 'max',  field: 'age' },
  });
// → [{ key: 'admin', total: 3, avgAge: 27.3, maxAge: 31 }, ...]

// Sum / avg / min / max over all documents
const totalScore = scores.aggregate().sum('points');
const average    = scores.aggregate().avg('points');

// Distinct values of a field
const roles = users.distinct('role');
// → ['admin', 'user']

// Full-text search (scored, multi-field)
const results = users.search('alice admin', ['name', 'role']);
```

---

## Schema Validation

Enforce structure on a collection so bad data never gets in.

```typescript
users.setSchema({
  name: 'users',
  strict: false,          // if true, unknown fields are rejected
  fields: {
    name:  { type: 'string',  required: true,  minLength: 2 },
    age:   { type: 'number',  required: true,  min: 0, max: 150 },
    email: { type: 'string',  required: false, match: /^.+@.+\..+$/ },
    role:  { type: 'string',  required: true,  enum: ['admin', 'user', 'guest'] },
    score: { type: 'number',  required: false },
    tags:  { type: 'array',   required: false },
  },
});

// Valid insert — passes
users.insert({ name: 'Alice', age: 29, role: 'admin' });

// Invalid insert — throws SchemaError
users.insert({ name: 'X', age: -5, role: 'superuser' });
// SchemaError: Schema violation on "name": length 1 is below minimum 2
```

### Supported field types

`string` · `number` · `integer` · `boolean` · `array` · `object` · `any`

---

## Field Indexes

Indexes make queries on a field dramatically faster — O(log n) instead of O(n).

```typescript
// Create an index on a field
users.createIndex('email');
users.createIndex('age');

// Queries on indexed fields use binary search automatically
const user  = users.query().where('email', '==', 'alice@x.com').first();
const young = users.query().where('age',   '<',  25).exec();

// List indexes
users.listIndexes(); // → ['email', 'age']

// Remove an index
users.dropIndex('email');
```

> **When to index:** index any field you query frequently. For small collections (<1 000 docs) indexes have little impact. For 10 000+ documents they make a real difference.

---

## Encryption

Encrypt everything at rest with one option.

```typescript
const db = new AgentDB('./vault', {
  encryptionKey: 'my-strong-password',
});
await db.open();

const secrets = db.collection('secrets');
secrets.insert({ key: 'stripe_live_key', value: 'sk_live_...' });
```

- Every record is encrypted individually with **AES-256-GCM**
- A unique 12-byte random IV is generated per record
- A 16-byte authentication tag prevents tampering
- The password is never stored — it is hashed using **PBKDF2-SHA-512** (100 000 iterations) with a random salt
- The raw `.agdb` file contains only ciphertext — opening it without the password returns nothing readable

> **Forget the password and the data is unrecoverable.** Store it in an environment variable, a secrets manager, or a password vault — never hardcode it in your source.

---

## Compression

Compression is automatic. Enable it globally or per collection:

```typescript
// Global (all collections)
const db = new AgentDB('./data', { compressionEnabled: true });

// Per collection
const logs = db.collection('logs', { compression: true });
```

AgentDB uses **smart compression** — it only compresses a record if:
1. The data is at least **64 bytes**
2. Compression saves at least **10%**

Otherwise the record is stored uncompressed. You never pay the decompression cost for records that wouldn't benefit.

---

## TTL — Auto-Expiring Documents

Documents can be set to expire automatically.

```typescript
// All documents in this collection expire after 1 hour
const sessions = db.collection('sessions', {
  ttl: 60 * 60 * 1000, // milliseconds
});

sessions.insert({ userId: 'abc', token: 'xyz' });
// → this document disappears after 1 hour

// Or set TTL per document
sessions.insert({ userId: 'def', token: 'uvw', _ttl: Date.now() + 30_000 });
// → expires after 30 seconds

// Manually purge expired documents
sessions.purgeExpired();
```

Expired documents are also cleaned up automatically every 60 seconds in the background.

---

## Events

Subscribe to changes on any collection.

```typescript
users.on('insert', ({ doc }) => {
  console.log('New user:', doc.name);
});

users.on('update', ({ doc, oldDoc }) => {
  console.log(`${oldDoc.name} → age changed to ${doc.age}`);
});

users.on('delete', ({ docId }) => {
  console.log('Deleted:', docId);
});

users.on('compact', () => {
  console.log('Collection compacted');
});

// Remove a listener
users.off('insert', myHandler);
```

---

## Backup & Restore

```typescript
// Create a snapshot (copies all .agdb files into _backups/)
const backup = db.backup('before-migration');
console.log(backup.id);        // "1743200000000_before-migration"
console.log(backup.sizeBytes); // total size in bytes

// List all backups
const backups = db.listBackups();

// Restore from a backup (atomic — full swap)
db.restore(backup.id);

// Auto-backup on open
const db = new AgentDB('./data', {
  backupOnOpen: true,
  maxBackups: 5,     // keep only the 5 most recent
});
```

---

## Migrations

When you change your data structure, migrations let you upgrade existing files safely.

```typescript
import { MigrationRunner } from 'agentdb/migration';

const runner = new MigrationRunner();

runner.register({
  version: 2,
  description: 'Add default role field to users',
  up: (filePath) => {
    // Read and rewrite the file with the new field
    // filePath is the absolute path to the .agdb file
  },
});

// Run all pending migrations on a file
runner.migrate('./data/users.agdb', currentVersion, 2);
```

---

## Modular Imports

Each module can be imported individually so you only pull in what you need.

```typescript
// From the cloned repo (src/)
import { AgentDB }           from './src/database.js';
import { Collection }        from './src/collection.js';
import { StorageEngine }     from './src/engine.js';
import { encrypt, decrypt }  from './src/encryption.js';
import { compress }          from './src/compression.js';
import { validateDocument }  from './src/schema.js';
import { MigrationRunner }   from './src/migration.js';
import { BackupManager }     from './src/backup.js';
import { WriteAheadLog }     from './src/wal.js';
import { crc32 }             from './src/crc32.js';
import { AgentDBError }      from './src/errors.js';

// Once published to npm, imports will be:
// import { AgentDB } from 'agentdb';
// import { encrypt } from 'agentdb/crypto';
// etc.
```

---

## Error Handling

All errors extend `AgentDBError` for easy `instanceof` checks.

```typescript
import {
  AgentDBError,
  CorruptionError,      // file header or CRC32 mismatch
  ChecksumError,        // record checksum failed
  WALError,             // write-ahead log failure / lock conflict
  EncryptionError,      // wrong password or tampered record
  SchemaError,          // field validation failure
  MigrationError,       // migration step failed
  CollectionNotFoundError,
  DocumentNotFoundError,
} from 'agentdb/errors';

try {
  db.collection('users').insert({ age: 'not-a-number' });
} catch (e) {
  if (e instanceof SchemaError) {
    console.error('Bad data:', e.message);
  }
}
```

---

## File Format

Each collection is stored in a single `.agdb` binary file.

```
┌─────────────────────────────────────────────┐
│  HEADER (32 bytes)                          │
│  "AGDB" magic · version · flags             │
│  created_at · updated_at · record_count     │
├─────────────────────────────────────────────┤
│  RECORD                                     │
│  crc32 (4) · key_len (2) · key             │
│  timestamp (8) · flags · data_len (4)       │
│  data (JSON, optionally compressed/encrypted)│
├─────────────────────────────────────────────┤
│  RECORD ...                                 │
├─────────────────────────────────────────────┤
│  TOMBSTONE (deleted record marker)          │
└─────────────────────────────────────────────┘
```

Alongside each `.agdb` file lives a `.wal` write-ahead log. Every write is journalled to the WAL first. On startup, if the WAL contains uncommitted operations (e.g. from a crash), they are replayed automatically before the database opens.

---

## Demo

### Terminal demo (interactive, typewriter effect)

```bash
cd agentdb
npm install
npm run demo
```

Press **Enter** to step through each section:

1. Open database
2. Insert & query
3. Compression
4. Encryption — watch plaintext disappear from raw bytes
5. WAL crash recovery — kill the process, data survives
6. Indexes & performance
7. Aggregation
8. Schema validation
9. Update, delete & compaction
10. File layout on disk

### Browser UI demo

Open `demo/browser-demo.html` directly in any browser — no server needed.

```bash
# Just open the file in your browser
start demo/browser-demo.html       # Windows
open  demo/browser-demo.html       # macOS
```

Features five preloaded collections with full Browse, Query, Insert, and Schema tabs. Includes dark mode toggle.

---

## Running Tests

```bash
npm test
```

```
Test Files  9 passed (9)
     Tests  170 passed (170)
  Duration  ~7s
```

Tests cover: CRC32, compression, encryption, WAL recovery, engine read/write, collection CRUD, cursor streaming, aggregation, schema validation, and the full database lifecycle.

---

## Requirements

- **Node.js 18+**
- **TypeScript 5.0+** (for type-checked usage)
- Zero runtime dependencies — uses only Node.js built-ins: `fs`, `path`, `crypto`, `zlib`, `events`

---

## License

Copyright 2026 Isaac

Licensed under the **Apache License 2.0**.

You are free to use, modify, and distribute this software — including in commercial projects — as long as you:
- Keep the copyright notice intact
- State any changes you made
- Include the license text in your distribution

You are **not** allowed to use the author's name to endorse derived products without permission.

See [LICENSE](./LICENSE) for the full text.

---

<div align="center">

Built by [Isaac Odeimor](https://github.com/IsaacOdeimor)

If AgentDB is useful to you, consider giving it a ⭐ on GitHub

</div>
