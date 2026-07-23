import * as fs from 'fs/promises';
import * as path from 'path';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './../videos/entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos-queue.module';
import * as Minio from 'minio';

const FIXTURE_PATH = path.join(__dirname, '../../test/fixtures/sample.mp4');
const BUCKET = process.env.STORAGE_BUCKET ?? 'videos';

async function waitForStatus(
  videoRepository: Repository<Video>,
  videoId: string,
  target: VideoStatus,
  timeoutMs: number,
): Promise<Video> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    if (video.status === target) return video;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for video ${videoId} to reach status ${target}`,
  );
}

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let minioClient: Minio.Client;
  let queue: Queue;

  beforeAll(async () => {
    // This test exercises the LIVE `video-worker` container end-to-end: it
    // enqueues a real job and waits for the worker to process it. The worker
    // reads/writes the runtime `streamtube` database, so this test must share
    // that same database (not the isolated `streamtube_test`) — otherwise the
    // worker would never see the rows this test creates.
    //
    // `synchronize: false` on purpose: the runtime database is already fully
    // migrated (via `npm run migration:run`) and is shared with the live app.
    // A test must never mutate that shared schema — it only reads/writes rows
    // through the existing tables.
    dataSource = createTestDataSource([User, Channel, Video], {
      database: process.env.DB_NAME ?? 'streamtube',
      synchronize: false,
    });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    minioClient = new Minio.Client({
      endPoint: process.env.STORAGE_ENDPOINT ?? 'minio',
      port: Number(process.env.STORAGE_PORT ?? 9000),
      useSSL: false,
      accessKey: process.env.STORAGE_ACCESS_KEY ?? 'streamtube',
      secretKey: process.env.STORAGE_SECRET_KEY ?? 'streamtube123',
    });
    storageService = new StorageService(minioClient, BUCKET);
    await storageService.onModuleInit();

    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `wchannel${n}`,
        nickname: `wchannel${n}`,
        user_id: user.id,
      }),
    );
  }

  it('processes a real video end-to-end: metadata extracted, thumbnail generated, status ready', async () => {
    const channel = await createChannel();
    const shortId = `proc${Date.now() % 100000}`;
    const storageKey = `${shortId}/original.mp4`;

    const fixtureBuffer = await fs.readFile(FIXTURE_PATH);
    await storageService.putObject(storageKey, fixtureBuffer);

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        short_id: shortId,
        title: 'Processing test video',
        storage_key: storageKey,
        status: VideoStatus.PROCESSING,
      }),
    );

    await queue.add('process-video', { videoId: video.id });

    const processed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.READY,
      20000,
    );

    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).not.toBeNull();
    expect(Number(processed.duration_seconds)).toBeGreaterThan(0);
    expect(processed.thumbnail_key).toBe(`${shortId}/thumbnail.jpg`);

    const thumbnailExists = await minioClient
      .statObject(BUCKET, processed.thumbnail_key as string)
      .then(() => true)
      .catch(() => false);
    expect(thumbnailExists).toBe(true);
  }, 30000);

  it('marks the video as error with processing_error after exhausting retries', async () => {
    const channel = await createChannel();
    const shortId = `fail${Date.now() % 100000}`;
    // Intentionally not uploading any object to this key — the worker's
    // getObjectToFile will fail, exercising the failure path.
    const storageKey = `${shortId}/original.mp4`;

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        short_id: shortId,
        title: 'Failing test video',
        storage_key: storageKey,
        status: VideoStatus.PROCESSING,
      }),
    );

    // Per-job override: few attempts + fast fixed backoff, so the test
    // exercises the real retries-exhausted path without waiting minutes
    // for the production exponential backoff (attempts: 8) to unwind.
    await queue.add(
      'process-video',
      { videoId: video.id },
      { attempts: 2, backoff: { type: 'fixed', delay: 200 } },
    );

    const failed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.ERROR,
      15000,
    );

    expect(failed.status).toBe(VideoStatus.ERROR);
    expect(failed.processing_error).not.toBeNull();
    expect(failed.processing_error).not.toBe('');
  }, 20000);
});
