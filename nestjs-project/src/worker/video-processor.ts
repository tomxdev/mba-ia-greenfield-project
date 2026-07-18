import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos-queue.module';

interface ProcessVideoJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneByOrFail({
      id: job.data.videoId,
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-'));
    const originalPath = path.join(tmpDir, 'original');
    const thumbnailFilename = 'thumbnail.jpg';

    try {
      await this.storageService.getObjectToFile(
        video.storage_key,
        originalPath,
      );

      const metadata = await this.ffprobe(originalPath);
      const durationSeconds = metadata.format.duration ?? null;

      await this.generateThumbnail(originalPath, tmpDir, thumbnailFilename);

      const thumbnailKey = this.storageService.thumbnailObjectKey(
        video.short_id,
      );
      const thumbnailBuffer = await fs.readFile(
        path.join(tmpDir, thumbnailFilename),
      );
      await this.storageService.putObject(thumbnailKey, thumbnailBuffer);

      video.duration_seconds = durationSeconds;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      await this.videoRepository.save(video);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Will still be retried by BullMQ — do not mark as error yet.
      return;
    }

    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.ERROR, processing_error: error.message },
    );
  }

  private ffprobe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(data);
      });
    });
  }

  private generateThumbnail(
    inputPath: string,
    folder: string,
    filename: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: ['10%'],
          filename,
          folder,
          size: '640x360',
        });
    });
  }
}
