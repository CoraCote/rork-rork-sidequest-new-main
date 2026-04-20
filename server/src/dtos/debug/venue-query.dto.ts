import { IsNotEmpty, IsString } from 'class-validator';

export class VenueQueryDto {
  @IsString()
  @IsNotEmpty()
  venue: string;
}
