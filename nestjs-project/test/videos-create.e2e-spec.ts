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

describe('videos-create', () => {
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

  it('1.1 cria-video-com-sucesso', async () => {
    const accessToken = await registerConfirmAndLogin('creator1@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'My video', fileName: 'movie.mp4', fileSizeBytes: 1024 })
      .expect(201);

    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.shortId).toEqual(expect.any(String));
    expect(res.body.status).toBe('draft');
    expect(res.body.uploadId).toEqual(expect.any(String));
    expect(res.body.channelId).toEqual(expect.any(String));
  });

  it('1.2 rejeita-arquivo-acima-de-10gb', async () => {
    const accessToken = await registerConfirmAndLogin('creator2@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Too big',
        fileName: 'movie.mp4',
        fileSizeBytes: 10 * 1024 * 1024 * 1024 + 1,
      })
      .expect(413);

    expect(res.body.error).toBe('FILE_TOO_LARGE');
  });

  it('1.3 rejeita-sem-autenticacao', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({ title: 'No auth', fileName: 'movie.mp4', fileSizeBytes: 1024 })
      .expect(401);
  });

  it('1.4 rejeita-corpo-invalido', async () => {
    const accessToken = await registerConfirmAndLogin('creator3@example.com');

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'movie.mp4', fileSizeBytes: 1024 })
      .expect(400);
  });
});
