import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and initiate a multipart upload',
    description:
      'Pre-registers the video as a draft for the authenticated user channel and starts a multipart upload in the object storage, returning the upload id used by subsequent part uploads.',
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        shortId: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        uploadId: { type: 'string' },
        channelId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared file size exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<{
    id: string;
    shortId: string;
    status: string;
    uploadId: string;
    channelId: string;
  }> {
    const video = await this.videosService.create(user.sub, dto);
    return {
      id: video.id,
      shortId: video.short_id,
      status: video.status,
      uploadId: video.upload_id ?? '',
      channelId: video.channel_id,
    };
  }

  @Post(':id/upload-parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Request presigned upload URLs for multipart upload parts',
    description:
      'Returns one presigned PUT URL per requested part number, allowing the client to upload parts directly to the object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs generated',
    schema: { properties: { urls: { type: 'object' } } },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async requestUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UploadPartsDto,
  ): Promise<{ urls: Record<number, string> }> {
    const urls = await this.videosService.requestUploadParts(
      user.sub,
      id,
      dto.partNumbers,
    );
    return { urls };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload and enqueue processing',
    description:
      'Completes the multipart upload in the object storage, transitions the video to processing, and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video transitioned to processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Storage rejected the multipart upload completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string }> {
    const video = await this.videosService.completeUpload(user.sub, id, dto);
    return { id: video.id, status: video.status };
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Returns the video details, including its current processing status, duration, and processing error when applicable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        shortId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        durationSeconds: { type: 'number', nullable: true },
        processingError: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findById(@Param('id') id: string): Promise<{
    id: string;
    shortId: string;
    title: string;
    status: string;
    durationSeconds: number | null;
    processingError: string | null;
    createdAt: Date;
  }> {
    const video = await this.videosService.findById(id);
    return {
      id: video.id,
      shortId: video.short_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      processingError: video.processing_error,
      createdAt: video.created_at,
    };
  }

  @Get(':shortId/stream')
  @Redirect()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Redirect to a presigned streaming URL for the video',
    description:
      'Validates the video is ready and redirects (302) to a presigned read URL in the object storage, without a content-disposition override, so the browser can play it inline with native Range/206 support.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('shortId') shortId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamRedirectUrl(shortId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':shortId/download')
  @Redirect()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Redirect to a presigned download URL for the video',
    description:
      'Validates the video is ready and redirects (302) to a presigned read URL in the object storage, with response-content-disposition: attachment, forcing a download instead of inline playback.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('shortId') shortId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadRedirectUrl(shortId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
