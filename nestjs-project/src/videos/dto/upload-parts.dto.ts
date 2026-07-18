import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';

export class UploadPartsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
