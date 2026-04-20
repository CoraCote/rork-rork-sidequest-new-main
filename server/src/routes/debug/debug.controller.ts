import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DebugService } from './debug.service';
import {
  ScrapeAndCacheDto,
  TestReviewQueryDto,
  VenueQueryDto,
  VenueCacheLookupQueryDto,
} from '../../dtos/debug';

@Controller('debug')
export class DebugController {
  constructor(private readonly debugService: DebugService) {}

  @Post('clear-review-cache')
  clearReviewCache() {
    return this.debugService.clearReviewCache();
  }

  @Post('clear-poisoned-reviews')
  clearPoisonedReviews() {
    return this.debugService.clearPoisonedReviews();
  }

  @Get('test-review')
  testReview(@Query() query: TestReviewQueryDto) {
    return this.debugService.testReview(
      query.venue,
      query.city ?? '',
      query.state ?? '',
      query.postal,
    );
  }

  @Get('check-venue-rating')
  checkVenueRating(@Query() query: VenueQueryDto) {
    return this.debugService.checkVenueRating(query.venue);
  }

  @Get('raw-event')
  getRawEvent(@Query() query: VenueQueryDto) {
    return this.debugService.getRawEvent(query.venue);
  }

  @Get('venue-cache-lookup')
  venueCacheLookup(@Query() query: VenueCacheLookupQueryDto) {
    return this.debugService.venueCacheLookup(
      query.venue,
      query.city ?? '',
      query.state ?? '',
      query.postal ?? '',
    );
  }

  @Post('scrape-and-cache')
  scrapeAndCache(@Body() dto: ScrapeAndCacheDto) {
    return this.debugService.scrapeAndCache(
      dto.venue,
      dto.city ?? '',
      dto.state ?? '',
      dto.postal ?? '',
    );
  }
}
