import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Client } from 'minio';
import { customAlphabet } from 'nanoid';
import { STORAGE_BUCKET, STORAGE_CLIENT } from './storage.constants';

const SHORT_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const generateShortIdValue = customAlphabet(SHORT_ID_ALPHABET, 10);

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  constructor(
    @Inject(STORAGE_CLIENT) private readonly client: Client,
    @Inject(STORAGE_BUCKET) private readonly bucket: string,
  ) {}

  async onModuleInit(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
    }
  }

  generateShortId(): string {
    return generateShortIdValue();
  }

  originalObjectKey(videoId: string, fileName: string): string {
    const lastDot = fileName.lastIndexOf('.');
    const extension = lastDot >= 0 ? fileName.slice(lastDot + 1) : 'bin';
    return `${videoId}/original.${extension}`;
  }

  thumbnailObjectKey(videoId: string): string {
    return `${videoId}/thumbnail.jpg`;
  }

  async presignedPutObject(
    objectKey: string,
    expirySeconds = 3600,
  ): Promise<string> {
    return this.client.presignedPutObject(
      this.bucket,
      objectKey,
      expirySeconds,
    );
  }

  async initiateMultipartUpload(objectKey: string): Promise<string> {
    return this.client.initiateNewMultipartUpload(this.bucket, objectKey, {});
  }

  async presignedUploadPartUrl(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expirySeconds = 3600,
  ): Promise<string> {
    return this.client.presignedUrl(
      'PUT',
      this.bucket,
      objectKey,
      expirySeconds,
      {
        uploadId,
        partNumber: String(partNumber),
      },
    );
  }

  async completeMultipartUpload(
    objectKey: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<{ etag: string }> {
    const result = await this.client.completeMultipartUpload(
      this.bucket,
      objectKey,
      uploadId,
      parts.map((p) => ({ part: p.partNumber, etag: p.etag })),
    );
    return { etag: result.etag };
  }

  async presignedGetObject(
    objectKey: string,
    expirySeconds = 3600,
    respHeaders?: Record<string, string>,
  ): Promise<string> {
    return this.client.presignedGetObject(
      this.bucket,
      objectKey,
      expirySeconds,
      respHeaders,
    );
  }

  async putObject(objectKey: string, data: Buffer): Promise<void> {
    await this.client.putObject(this.bucket, objectKey, data);
  }

  async getObjectToFile(objectKey: string, filePath: string): Promise<void> {
    await this.client.fGetObject(this.bucket, objectKey, filePath);
  }
}
