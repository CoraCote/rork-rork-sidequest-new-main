import { Module } from '@nestjs/common';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';
import { TicketmasterHelper } from '../../helpers/ticketmaster.helper';
import { EventbriteHelper } from '../../helpers/eventbrite.helper';
import { GoogleEventsHelper } from '../../helpers/google-events.helper';
import { RunSignupHelper } from '../../helpers/runsignup.helper';
import { DiscotechHelper } from '../../helpers/discotech.helper';
import { ClubbableHelper } from '../../helpers/clubbable.helper';
import { NightlifeEnrichmentHelper } from '../../helpers/nightlife-enrichment.helper';
import { GoogleReviewsHelper } from '../../helpers/google-reviews.helper';
import { SnapshotBuilderHelper } from '../../helpers/snapshot-builder.helper';
import { TileMathHelper } from '../../helpers/tile-math.helper';

@Module({
  controllers: [WorkerController],
  providers: [
    WorkerService,
    TicketmasterHelper,
    EventbriteHelper,
    GoogleEventsHelper,
    RunSignupHelper,
    DiscotechHelper,
    ClubbableHelper,
    NightlifeEnrichmentHelper,
    GoogleReviewsHelper,
    SnapshotBuilderHelper,
    TileMathHelper,
  ],
})
export class WorkerModule {}
