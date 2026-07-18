import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoForbiddenException extends DomainException {
  constructor() {
    super('VIDEO_FORBIDDEN', 403, 'You are not the owner of this video');
  }
}

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 413, 'File size exceeds the 10GB limit');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATE',
      409,
      'This operation is not allowed in the video current state',
    );
  }
}

export class MultipartCompleteFailedException extends DomainException {
  constructor() {
    super(
      'MULTIPART_COMPLETE_FAILED',
      400,
      'Storage rejected the multipart upload completion',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}
