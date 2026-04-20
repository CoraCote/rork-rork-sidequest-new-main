import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class RunSignupSearchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsString()
  created_since?: string;

  @IsOptional()
  @IsString()
  created_on_or_before?: string;

  @IsOptional()
  @IsString()
  modified_since?: string;

  @IsOptional()
  @IsString()
  modified_on_or_before?: string;

  @IsOptional()
  @IsIn(['T', 'F'])
  only_partner_races?: 'T' | 'F';

  @IsOptional()
  @IsIn(['T', 'F'])
  search_start_date_only?: 'T' | 'F';

  @IsOptional()
  @IsIn(['T', 'F'])
  only_races_with_results?: 'T' | 'F';

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  event_type?: string;

  @IsOptional()
  @IsNumber()
  min_distance?: number;

  @IsOptional()
  @IsNumber()
  max_distance?: number;

  @IsOptional()
  @IsIn(['K', 'M'])
  distance_units?: 'K' | 'M';

  @IsOptional()
  @IsString()
  zipcode?: string;

  @IsOptional()
  @IsNumber()
  radius?: number;

  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsNumber()
  results_per_page?: number;

  @IsOptional()
  @IsString()
  sort?: string;
}
