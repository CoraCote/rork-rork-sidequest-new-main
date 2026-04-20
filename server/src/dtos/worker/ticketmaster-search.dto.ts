import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class TicketmasterSearchDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  attractionId?: string;

  @IsOptional()
  @IsString()
  venueId?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  latlong?: string;

  @IsOptional()
  @IsNumber()
  radius?: number;

  @IsOptional()
  @IsIn(['miles', 'km'])
  unit?: 'miles' | 'km';

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  marketId?: string;

  @IsOptional()
  @IsString()
  startDateTime?: string;

  @IsOptional()
  @IsString()
  endDateTime?: string;

  @IsOptional()
  @IsIn(['yes', 'no', 'only'])
  includeTBA?: 'yes' | 'no' | 'only';

  @IsOptional()
  @IsIn(['yes', 'no', 'only'])
  includeTBD?: 'yes' | 'no' | 'only';

  @IsOptional()
  @IsIn(['yes', 'no', 'only'])
  includeTest?: 'yes' | 'no' | 'only';

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  countryCode?: string;

  @IsOptional()
  @IsString()
  stateCode?: string;

  @IsOptional()
  @IsString()
  classificationName?: string;

  @IsOptional()
  @IsString()
  classificationId?: string;

  @IsOptional()
  @IsString()
  dmaId?: string;

  @IsOptional()
  @IsString()
  segmentId?: string;

  @IsOptional()
  @IsString()
  segmentName?: string;

  @IsOptional()
  @IsString()
  promoterId?: string;

  @IsOptional()
  @IsString()
  genreId?: string;

  @IsOptional()
  @IsString()
  subGenreId?: string;

  @IsOptional()
  @IsString()
  geoPoint?: string;

  @IsOptional()
  @IsString()
  preferredCountry?: string;

  @IsOptional()
  @IsIn(['yes', 'no'])
  includeSpellcheck?: 'yes' | 'no';
}
