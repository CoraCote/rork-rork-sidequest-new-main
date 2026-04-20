import { Controller, Post, Delete, Get, Query, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WorkerService } from './worker.service';
import { EventbriteHelper } from '../../helpers/eventbrite.helper';
import { RunSignupHelper } from '../../helpers/runsignup.helper';
import { TicketmasterHelper } from '../../helpers/ticketmaster.helper';
import { DiscotechHelper } from '../../helpers/discotech.helper';
import { ClubbableHelper } from '../../helpers/clubbable.helper';
import {
  DiscotechVenueEventsDto,
  DiscotechVenuesDto,
  RunSignupSearchDto,
  TicketmasterSearchDto,
} from '../../dtos';

@SkipThrottle()
@Controller('worker')
export class WorkerController {
  constructor(
    private readonly workerService: WorkerService,
    private readonly eventbriteHelper: EventbriteHelper,
    private readonly runSignupHelper: RunSignupHelper,
    private readonly ticketmasterHelper: TicketmasterHelper,
    private readonly discotechHelper: DiscotechHelper,
    private readonly clubbableHelper: ClubbableHelper,
  ) {}

  @Post('start')
  startWorker() {
    return this.workerService.startWorker();
  }

  @Delete('stop')
  stopWorker() {
    return this.workerService.stopWorker();
  }

  @Get('status')
  getWorkerStatus() {
    return this.workerService.getWorkerStatus();
  }

  @Get('eventbrite')
  async testEventbrite() {
    return await this.eventbriteHelper.fetchUnitedStatesEventsDetailed();
  }

  @Get('runsignup')
  async testRunSignup(@Query() query: RunSignupSearchDto) {
    return await this.runSignupHelper.searchRacesWithDetails(query);
  }

  @Get('ticketmaster')
  async testTicketmaster(@Query() query: TicketmasterSearchDto) {
    return await this.ticketmasterHelper.searchAllEvents(query);
  }

  @Get('ticketmaster/:eventId')
  async testTicketmasterEvent(@Param('eventId') eventId: string) {
    return await this.ticketmasterHelper.getEventDetail(eventId);
  }

  @Get('discotech/venues')
  async testDiscotechVenues(@Query() query: DiscotechVenuesDto) {
    return await this.discotechHelper.fetchVenues(query);
  }

  @Get('discotech/venues-with-events')
  async testDiscotechVenuesWithEvents(@Query() query: DiscotechVenuesDto) {
    return await this.discotechHelper.fetchVenuesWithEvents(query);
  }

  @Get('discotech/events')
  async testDiscotechEvents(@Query() query: DiscotechVenueEventsDto) {
    return await this.discotechHelper.fetchVenueEvents(query);
  }

  @Get('clubbable/cities')
  async testClubbableCities() {
    return await this.clubbableHelper.fetchCities();
  }

  @Get('clubbable/city/:citySlug')
  async testClubbableCity(@Param('citySlug') citySlug: string) {
    return await this.clubbableHelper.fetchCityWithClubs(citySlug);
  }

  @Get('clubbable/all')
  async testClubbableAll() {
    return await this.clubbableHelper.fetchAllCitiesWithClubs();
  }
}
