import { IsNotEmpty, IsString } from 'class-validator';

export class TriggerMetroDto {
  @IsString()
  @IsNotEmpty()
  metro_slug: string;
}
