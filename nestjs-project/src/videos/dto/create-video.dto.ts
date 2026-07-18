import { IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  fileName: string;

  @IsNumber()
  @IsPositive()
  fileSizeBytes: number;
}
