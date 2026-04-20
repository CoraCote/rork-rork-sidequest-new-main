import { IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class TriggerBackfillDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  tier?: number;
}
