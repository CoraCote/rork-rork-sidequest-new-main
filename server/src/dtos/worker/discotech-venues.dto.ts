import { IsNumber, IsOptional, IsString } from 'class-validator';

export class DiscotechVenuesDto {
  @IsOptional()
  @IsNumber()
  page?: number;
}

export class DiscotechVenueEventsDto {
  @IsString()
  venue_slug: string;

  @IsString()
  city_slug: string;

  @IsOptional()
  @IsNumber()
  page?: number;
}
