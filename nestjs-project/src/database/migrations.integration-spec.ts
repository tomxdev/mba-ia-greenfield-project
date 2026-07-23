import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1784345212760 } from './migrations/1784345212760-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        // Dedicated database owned solely by this spec — it drops and recreates
        // every table, so it must not share the `streamtube_test` database used
        // by the synchronize-based specs (that would make the suite order- and
        // state-dependent). Provisioned by src/test/global-setup.ts.
        database:
          process.env.DB_MIGRATIONS_TEST_NAME ?? 'streamtube_test_migrations',
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1784345212760,
        ],
      },
    );

    await dataSource.initialize();

    // Drop sequentially (not via Promise.all): concurrent `DROP TABLE ... CASCADE`
    // on FK-linked tables can deadlock against each other as they grab locks on
    // referenced tables in different orders. This runs against the dedicated
    // `streamtube_test` database (isolated from the live stack), so there is no
    // contention with the running worker.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // DROP TABLE does not drop enum types owned by table columns —
    // without this, re-running this suite against a previously migrated DB fails
    // with "type ... already exists".
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum" CASCADE`);
  });

  afterAll(async () => {
    // The revert test undoes the last migration, leaving the videos table
    // missing. Re-apply so the test database is fully migrated when subsequent
    // integration suites (which share `streamtube_test`) run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should enforce unique short_id and FK to channels on videos', async () => {
    const columns = await dataSource.query<
      { column_name: string; is_nullable: string }[]
    >(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'videos'
       ORDER BY column_name`,
    );
    const columnNames = columns.map((c) => c.column_name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'channel_id',
        'short_id',
        'title',
        'status',
        'processing_error',
        'storage_key',
        'thumbnail_key',
        'duration_seconds',
        'upload_id',
        'file_size_bytes',
        'created_at',
        'updated_at',
      ]),
    );

    const constraints = await dataSource.query<{ constraint_type: string }[]>(
      `SELECT tc.constraint_type FROM information_schema.table_constraints tc
       WHERE tc.table_schema = 'public' AND tc.table_name = 'videos'
         AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(constraints).toHaveLength(1);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    expect(result).toHaveLength(0);
  });
});
