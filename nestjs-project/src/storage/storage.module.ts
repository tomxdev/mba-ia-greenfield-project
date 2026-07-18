import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as Minio from 'minio';
import storageConfig from '../config/storage.config';
import { STORAGE_BUCKET, STORAGE_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: STORAGE_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new Minio.Client({
          endPoint: config.endpoint,
          port: config.port,
          useSSL: false,
          accessKey: config.accessKey,
          secretKey: config.secretKey,
        }),
    },
    {
      provide: STORAGE_BUCKET,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) => config.bucket,
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
