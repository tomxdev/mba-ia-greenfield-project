import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

@Module({
  imports: [
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: 8,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
      },
    }),
  ],
  exports: [BullModule],
})
export class VideosQueueModule {}
