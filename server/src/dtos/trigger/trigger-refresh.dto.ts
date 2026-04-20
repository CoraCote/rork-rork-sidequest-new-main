import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TriggerRefreshDto {
  @IsString()
  @IsNotEmpty()
  metro_slug: string;

  @IsString()
  @IsOptional()
  intent?: string;
}
