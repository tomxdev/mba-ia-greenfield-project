import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
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
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `channel${n}`,
        nickname: `channel${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      channel_id: channelId,
      short_id: `short${++counter}`,
      title: 'My video',
      storage_key: `some-id/original.mp4`,
      ...overrides,
    };
  }

  it('should persist a video with default status draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.created_at).toBeInstanceOf(Date);
  });

  it('should allow nullable fields to be null', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.processing_error).toBeNull();
  });

  it('should enforce unique short_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { short_id: 'dup1234567' }),
      ),
    );

    const second = videoRepository.create(
      buildVideo(channel.id, { short_id: 'dup1234567' }),
    );

    await expect(videoRepository.save(second)).rejects.toThrow();
  });

  it('should require channel_id (FK constraint)', async () => {
    const video = videoRepository.create({
      channel_id: '00000000-0000-0000-0000-000000000000',
      short_id: 'noFkVideo1',
      title: 'orphan',
      storage_key: 'x/original.mp4',
    });

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should load the related channel via ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, { short_id: 'relVideo01' }),
      ),
    );

    const found = await videoRepository.findOne({
      where: { short_id: 'relVideo01' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
