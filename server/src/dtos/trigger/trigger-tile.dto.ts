import { IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class TriggerTileDto {
  @IsNumber()
  @Type(() => Number)
  z: number;

  @IsNumber()
  @Type(() => Number)
  x: number;

  @IsNumber()
  @Type(() => Number)
  y: number;
}
