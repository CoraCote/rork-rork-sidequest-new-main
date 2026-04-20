import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { TicketmasterHelper } from '../../helpers/ticketmaster.helper';
import { EventbriteHelper } from '../../helpers/eventbrite.helper';
import { RunSignupHelper } from '../../helpers/runsignup.helper';
import { DiscotechHelper } from '../../helpers/discotech.helper';
import { ClubbableHelper } from '../../helpers/clubbable.helper';
import { OsmHelper } from '../../helpers/osm.helper';
import { EventDedupHelper } from '../../helpers/event-dedup.helper';
import { EventNormalizerHelper } from '../../helpers/event-normalizer.helper';
import { EventsRepositoryHelper } from '../../helpers/events-repository.helper';

@Module({
  controllers: [EventsController],
  providers: [
    EventsService,
    TicketmasterHelper,
    EventbriteHelper,
    RunSignupHelper,
    DiscotechHelper,
    ClubbableHelper,
    OsmHelper,
    EventDedupHelper,
    EventNormalizerHelper,
    EventsRepositoryHelper,
  ],
})
export class EventsModule {}
