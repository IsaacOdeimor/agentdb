# AgentDB

A lightweight embedded document database for Node.js.

AgentDB stores JSON-like documents on disk in a custom binary format. It supports collections, queries, indexes, schema validation, compression, encryption, write-ahead logging, backups, migrations, TTL documents, events, and aggregation.

## Why I built it

I wanted to understand what actually goes into a database beyond the API surface. So I built one from the storage layer up: file format, records, checksums, WAL recovery, indexes, query builder, validation, encryption, and developer-facing APIs.

The goal was to make something small enough to understand, but real enough to use in local tools and prototypes.

## What it does

- Stores documents in binary `.agdb` files
- Uses a write-ahead log for crash recovery
- Supports collections and CRUD operations
- Provides a chainable query builder
- Supports field indexes for faster lookups
- Encrypts records with AES-256-GCM
- Compresses records when it saves space
- Validates documents with collection schemas
- Supports TTL auto-expiring documents
- Includes backups, restore, migrations, and events
- Runs with zero runtime dependencies

## Tech stack

- Node.js
- TypeScript
- Node built-ins: `fs`, `path`, `crypto`, `zlib`, `events`
- Vitest

## Run locally

```bash
git clone https://github.com/IsaacOdeimor/agentdb.git
cd agentdb
npm install
npm test
```

## Basic usage

```ts
import { AgentDB } from './src/database.js';

const db = new AgentDB('./data');
await db.open();

const users = db.collection('users');

users.insert({ name: 'Alice', age: 29, role: 'admin' });
users.insert({ name: 'Bob', age: 34, role: 'user' });

const admins = users
  .query()
  .where('role', '==', 'admin')
  .sort('name', 'asc')
  .exec();

console.log(admins);

db.close();
```

## Database options

```ts
const db = new AgentDB('./data', {
  compressionEnabled: true,
  encryptionKey: process.env.AGENTDB_KEY,
  autoCompact: true,
  compactThreshold: 0.3,
  backupOnOpen: true,
  maxBackups: 5,
});
```

## Query example

```ts
const results = users
  .query()
  .where('age', '>=', 18)
  .where('role', '==', 'admin')
  .sort('name', 'asc')
  .skip(20)
  .limit(10)
  .select('name', 'age')
  .exec();
```

## Schema validation

```ts
users.setSchema({
  name: 'users',
  strict: false,
  fields: {
    name: { type: 'string', required: true, minLength: 2 },
    age: { type: 'number', required: true, min: 0 },
    role: { type: 'string', required: true, enum: ['admin', 'user'] },
  },
});
```

## Indexes

```ts
users.createIndex('email');
users.createIndex('age');

const user = users
  .query()
  .where('email', '==', 'alice@example.com')
  .first();
```

## Encryption

```ts
const db = new AgentDB('./vault', {
  encryptionKey: process.env.AGENTDB_KEY,
});
```

Records are encrypted individually with AES-256-GCM. The encryption key is never stored by the database.

## Tests

```bash
npm test
```

Current coverage includes storage, CRC checks, compression, encryption, WAL recovery, collection CRUD, cursors, aggregation, schema validation, and database lifecycle behavior.

## Notes

The most interesting parts to review are the storage engine, binary file layout, WAL recovery, encryption path, query builder, indexing, and schema validation. This project is more systems-heavy than UI-heavy, and I built it to push myself deeper than normal app development.

## License

Apache-2.0
