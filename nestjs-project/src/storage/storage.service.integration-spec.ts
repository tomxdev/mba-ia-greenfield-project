import * as Minio from 'minio';
import { StorageService } from './storage.service';

const BUCKET = process.env.STORAGE_BUCKET ?? 'videos';

describe('StorageService (integration)', () => {
  let client: Minio.Client;
  let service: StorageService;

  beforeAll(async () => {
    client = new Minio.Client({
      endPoint: process.env.STORAGE_ENDPOINT ?? 'minio',
      port: Number(process.env.STORAGE_PORT ?? 9000),
      useSSL: false,
      accessKey: process.env.STORAGE_ACCESS_KEY ?? 'streamtube',
      secretKey: process.env.STORAGE_SECRET_KEY ?? 'streamtube123',
    });
    service = new StorageService(client, BUCKET);
    await service.onModuleInit();
  });

  it('should ensure the bucket exists after onModuleInit', async () => {
    const exists = await client.bucketExists(BUCKET);
    expect(exists).toBe(true);
  });

  it('should generate a unique 10-character short id', () => {
    const a = service.generateShortId();
    const b = service.generateShortId();

    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    expect(a).not.toBe(b);
  });

  it('should build object keys for original file and thumbnail', () => {
    expect(service.originalObjectKey('video-1', 'movie.mp4')).toBe(
      'video-1/original.mp4',
    );
    expect(service.thumbnailObjectKey('video-1')).toBe('video-1/thumbnail.jpg');
  });

  it('should return a valid presigned PUT URL for a whole object', async () => {
    const url = await service.presignedPutObject('unit-test/whole-object.bin');

    expect(url).toContain(BUCKET);
    expect(url).toContain('unit-test/whole-object.bin');
    expect(url).toContain('X-Amz-Signature');
  });

  it('should return a presigned GET URL with response-content-disposition override', async () => {
    const key = 'unit-test/get-object.bin';
    await service.putObject(key, Buffer.from('hello world'));

    const url = await service.presignedGetObject(key, 3600, {
      'response-content-disposition': 'attachment; filename="video.mp4"',
    });

    expect(decodeURIComponent(url)).toContain(
      'response-content-disposition=attachment; filename="video.mp4"',
    );
  });

  it('should complete a full multipart upload flow against real MinIO', async () => {
    const key = `unit-test/multipart-${Date.now()}.bin`;
    const uploadId = await service.initiateMultipartUpload(key);
    expect(uploadId).toEqual(expect.any(String));

    // MinIO enforces a 5MB minimum part size for all parts except the last.
    const partData = Buffer.alloc(5 * 1024 * 1024, 'a');
    const partUrl = await service.presignedUploadPartUrl(key, uploadId, 1);

    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: partData,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const result = await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);
    expect(result.etag).toEqual(expect.any(String));
  }, 30000);
});
