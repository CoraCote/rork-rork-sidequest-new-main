import { IsNotEmpty, IsString } from 'class-validator';

export class TriggerPoiDto {
  @IsString()
  @IsNotEmpty()
  metro_slug: string;
}
