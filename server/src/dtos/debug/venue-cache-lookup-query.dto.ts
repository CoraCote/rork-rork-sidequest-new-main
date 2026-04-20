import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class VenueCacheLookupQueryDto {
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
