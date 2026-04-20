import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TestReviewQueryDto {
  @IsString()
  @IsNotEmpty()
  venue: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  postal?: string;
}
