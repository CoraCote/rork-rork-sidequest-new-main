import { Body, Controller, Post } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import {
  TriggerRefreshDto,
  TriggerBackfillDto,
  TriggerMetroDto,
  TriggerTileDto,
  TriggerOnDemandDto,
  TriggerPoiDto,
} from '../../dtos/trigger';

@Controller()
export class TriggerController {
  constructor(private readonly triggerService: TriggerService) {}

  @Post('trigger-refresh')
  triggerRefresh(@Body() dto: TriggerRefreshDto) {
    return this.triggerService.triggerRefresh(dto.metro_slug, dto.intent);
  }

  @Post('trigger-backfill')
  triggerBackfill(@Body() dto: TriggerBackfillDto) {
    return this.triggerService.triggerBackfill(dto.tier ?? 1);
  }

  @Post('trigger-metro-refresh')
  triggerMetroRefresh(@Body() dto: TriggerMetroDto) {
    return this.triggerService.triggerMetroRefresh(dto.metro_slug);
  }

  @Post('trigger-tile-scrape')
  triggerTileScrape(@Body() dto: TriggerTileDto) {
    return this.triggerService.triggerTileScrape(dto.z, dto.x, dto.y);
  }

  @Post('trigger-metro-batch')
  triggerMetroBatch(@Body() dto: TriggerMetroDto) {
    return this.triggerService.triggerMetroBatch(dto.metro_slug);
  }

  @Post('trigger-on-demand-tile')
  triggerOnDemandTile(@Body() dto: TriggerOnDemandDto) {
    return this.triggerService.triggerOnDemandTile(
      dto.z,
      dto.x,
      dto.y,
      dto.lat,
      dto.lon,
    );
  }

  @Post('trigger-poi-refresh')
  triggerPoiRefresh(@Body() dto: TriggerPoiDto) {
    return this.triggerService.triggerPoiRefresh(dto.metro_slug);
  }
}
