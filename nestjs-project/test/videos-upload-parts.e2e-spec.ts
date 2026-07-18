import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos-queue.module';

describe('videos-upload-parts', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoProcessingQueue: Queue;

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
    videoProcessingQueue = moduleFixture.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await videoProcessingQueue.drain(true);
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

  async function createDraftVideo(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'My video', fileName: 'movie.mp4', fileSizeBytes: 1024 });
    return res.body.id as string;
  }

  it('1.1 rejeita-upload-parts-de-outro-usuario', async () => {
    const ownerToken = await registerConfirmAndLogin('owner1@example.com');
    const videoId = await createDraftVideo(ownerToken);
    const otherToken = await registerConfirmAndLogin('other1@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-parts`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ partNumbers: [1] })
      .expect(403);

    expect(res.body.error).toBe('VIDEO_FORBIDDEN');
  });

  it('1.2 completa-upload-transiciona-para-processing', async () => {
    const ownerToken = await registerConfirmAndLogin('owner2@example.com');
    const videoId = await createDraftVideo(ownerToken);

    const partsRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ partNumbers: [1] })
      .expect(200);

    const partUrl = partsRes.body.urls['1'] as string;
    expect(partUrl).toEqual(expect.any(String));

    // MinIO enforces a 5MB minimum part size for non-final parts.
    const partData = Buffer.alloc(5 * 1024 * 1024, 'a');
    const putResponse = await fetch(partUrl, { method: 'PUT', body: partData });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);

    expect(completeRes.body.status).toBe('processing');

    const jobs = await videoProcessingQueue.getJobs(['waiting', 'active']);
    expect(jobs.some((j) => j.data.videoId === videoId)).toBe(true);
  }, 30000);

  it('1.3 rejeita-complete-de-video-ja-processando', async () => {
    const ownerToken = await registerConfirmAndLogin('owner3@example.com');
    const videoId = await createDraftVideo(ownerToken);

    const partsRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-parts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const partUrl = partsRes.body.urls['1'] as string;

    const partData = Buffer.alloc(5 * 1024 * 1024, 'a');
    const putResponse = await fetch(partUrl, { method: 'PUT', body: partData });
    const etag = putResponse.headers.get('etag') ?? '';

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(409);

    expect(res.body.error).toBe('INVALID_VIDEO_STATE');
  }, 30000);
});
