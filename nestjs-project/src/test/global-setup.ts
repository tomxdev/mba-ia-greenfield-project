import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * Jest globalSetup — runs once before the whole integration suite.
 *
 * Creates the dedicated integration-test databases (if they do not already
 * exist), both isolated from the runtime `streamtube` database used by the
 * live `nestjs-api` and `video-worker` containers:
 *
 * - `DB_TEST_NAME` (`streamtube_test`): shared by the `synchronize: true`
 *   integration specs (auth, users, channels, storage, entity constraints).
 * - `DB_MIGRATIONS_TEST_NAME` (`streamtube_test_migrations`): owned solely by
 *   the migrations integration spec, which drops and recreates every table.
 *   Giving it its own database keeps its destructive schema operations from
 *   interfering with the synchronize-based specs (and vice-versa), so the
 *   suite is deterministic regardless of run order or leftover state.
 *
 * Running these against a dedicated database (never `streamtube`) is what lets
 * the schema-owning migrations spec run with the full stack up without
 * deadlocking against the worker's open connections.
 *
 * globalSetup runs in its own module context and does NOT execute the
 * per-suite `setupFiles`, so `.env` is loaded explicitly above.
 */
export default async function globalSetup(): Promise<void> {
  const testDatabases = [
    process.env.DB_TEST_NAME ?? 'streamtube_test',
    process.env.DB_MIGRATIONS_TEST_NAME ?? 'streamtube_test_migrations',
  ];

  // Connect to the default `postgres` maintenance database to issue
  // CREATE DATABASE. TypeORM's DataSource is fully typed (unlike the raw pg
  // client), which keeps this file lint-clean.
  const admin = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: 'postgres',
  });

  await admin.initialize();
  try {
    for (const dbName of testDatabases) {
      const existing = await admin.query<unknown[]>(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName],
      );
      if (existing.length === 0) {
        // Database identifiers cannot be parameterized; dbName is derived from
        // config, not user input. Quote it to be safe.
        await admin.query(`CREATE DATABASE "${dbName}"`);
      }
    }
  } finally {
    await admin.destroy();
  }
}
