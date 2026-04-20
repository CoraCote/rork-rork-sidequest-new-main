import { IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class TriggerOnDemandDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  z?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  x?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  y?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  lat?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  lon?: number;
}
