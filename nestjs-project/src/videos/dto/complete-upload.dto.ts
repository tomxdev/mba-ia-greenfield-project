import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

class CompletedPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
