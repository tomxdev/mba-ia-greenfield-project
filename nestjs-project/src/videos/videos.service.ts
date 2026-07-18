import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  FileTooLargeException,
  InvalidVideoStateException,
  MultipartCompleteFailedException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VIDEO_PROCESSING_QUEUE } from './videos-queue.module';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
const MAX_SHORT_ID_RETRIES = 5;
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolationOnShortId(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('short_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoForbiddenException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }
    return video;
  }

  async requestUploadParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<Record<number, string>> {
    const video = await this.findOwnedDraft(userId, videoId);

    const urls: Record<number, string> = {};
    for (const partNumber of partNumbers) {
      urls[partNumber] = await this.storageService.presignedUploadPartUrl(
        video.storage_key,
        video.upload_id ?? '',
        partNumber,
      );
    }
    return urls;
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.findOwnedDraft(userId, videoId);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id ?? '',
        dto.parts,
      );
    } catch {
      throw new MultipartCompleteFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    await this.videoProcessingQueue.add('process-video', {
      videoId: video.id,
    });

    return video;
  }

  async create(userId: string, dto: CreateVideoDto): Promise<Video> {
    if (dto.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(
        `Authenticated user ${userId} has no channel — invariant violated`,
      );
    }

    let video: Video | undefined;

    for (let attempt = 0; attempt <= MAX_SHORT_ID_RETRIES; attempt++) {
      const shortId = this.storageService.generateShortId();
      const storageKey = this.storageService.originalObjectKey(
        shortId,
        dto.fileName,
      );

      try {
        video = await this.videoRepository.save(
          this.videoRepository.create({
            channel_id: channel.id,
            short_id: shortId,
            title: dto.title,
            storage_key: storageKey,
            file_size_bytes: dto.fileSizeBytes,
          }),
        );
        break;
      } catch (err) {
        if (!isUniqueViolationOnShortId(err)) throw err;
      }
    }

    if (!video) {
      throw new Error(
        'short_id conflict could not be resolved after max retries',
      );
    }

    const uploadId = await this.storageService.initiateMultipartUpload(
      video.storage_key,
    );
    video.upload_id = uploadId;
    return this.videoRepository.save(video);
  }

  async findById(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findReadyByShortId(shortId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ short_id: shortId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async getStreamRedirectUrl(shortId: string): Promise<string> {
    const video = await this.findReadyByShortId(shortId);
    return this.storageService.presignedGetObject(video.storage_key);
  }

  async getDownloadRedirectUrl(shortId: string): Promise<string> {
    const video = await this.findReadyByShortId(shortId);
    return this.storageService.presignedGetObject(video.storage_key, 3600, {
      'response-content-disposition': `attachment; filename="${video.title}"`,
    });
  }
}
