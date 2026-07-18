import * as fs from 'fs/promises';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const FIXTURE_PATH = path.join(__dirname, 'fixtures/sample.mp4');

async function waitForStatus(
  dataSource: DataSource,
  videoId: string,
  target: VideoStatus,
  timeoutMs: number,
): Promise<Video> {
  const videoRepository = dataSource.getRepository(Video);
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

describe('videos-playback', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  async function createReadyVideo(accessToken: string): Promise<{
    id: string;
    shortId: string;
  }> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Playback test video',
        fileName: 'movie.mp4',
        fileSizeBytes: 1717,
      })
      .expect(201);
    const videoId = createRes.body.id as string;
    const shortId = createRes.body.shortId as string;

    const partsRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const partUrl = partsRes.body.urls['1'] as string;

    const fixtureBuffer = await fs.readFile(FIXTURE_PATH);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: fixtureBuffer,
    });
    const etag = putResponse.headers.get('etag') ?? '';

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);

    await waitForStatus(dataSource, videoId, VideoStatus.READY, 30000);

    return { id: videoId, shortId };
  }

  it('1.1 stream-redireciona-para-storage', async () => {
    const accessToken = await registerConfirmAndLogin('playback1@example.com');
    const { shortId } = await createReadyVideo(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${shortId}/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(302);

    expect(res.headers.location).toEqual(expect.any(String));
    expect(res.headers.location).toContain('minio');
  }, 40000);

  it('1.2 download-redireciona-com-content-disposition', async () => {
    const accessToken = await registerConfirmAndLogin('playback2@example.com');
    const { shortId } = await createReadyVideo(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${shortId}/download`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(302);

    expect(res.headers.location).toContain(
      'response-content-disposition=attachment',
    );
  }, 40000);

  it('1.3 stream-video-nao-pronto', async () => {
    const accessToken = await registerConfirmAndLogin('playback3@example.com');
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Not ready video',
        fileName: 'movie.mp4',
        fileSizeBytes: 1717,
      })
      .expect(201);
    const shortId = createRes.body.shortId as string;

    const res = await request(app.getHttpServer())
      .get(`/videos/${shortId}/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);

    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });

  it('1.4 get-video-inexistente-404', async () => {
    const accessToken = await registerConfirmAndLogin('playback4@example.com');

    const res = await request(app.getHttpServer())
      .get('/videos/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });
});
