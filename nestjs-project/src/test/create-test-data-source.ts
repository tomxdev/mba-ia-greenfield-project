import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

type EntityClass = new (...args: any[]) => object;

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
  /**
   * Override the database to connect to. Defaults to the dedicated
   * integration-test database (`DB_TEST_NAME`, `streamtube_test`), which is
   * isolated from the runtime `streamtube` database used by the live
   * `nestjs-api` and `video-worker` containers. Pass the runtime database
   * name only for tests that must share state with a live service (e.g. the
   * video-processor test, which needs the running worker to see its rows).
   */
  database?: string;
}

export const TEST_DATABASE_NAME = process.env.DB_TEST_NAME ?? 'streamtube_test';

export function createTestDataSource(
  entities: (EntityClass | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations, database } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: database ?? TEST_DATABASE_NAME,
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
