import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { EventsService } from './events.service';
import { ViewportQueryDto } from '../../dtos';

@SkipThrottle()
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post('ingest/la')
  ingestLA() {
    return this.eventsService.ingestLosAngeles();
  }

  @Get('viewport')
  viewportGet(@Query() query: ViewportQueryDto) {
    return this.eventsService.queryViewport(query);
  }

  @Post('viewport')
  viewportPost(@Body() body: ViewportQueryDto) {
    return this.eventsService.queryViewport(body);
  }
}
