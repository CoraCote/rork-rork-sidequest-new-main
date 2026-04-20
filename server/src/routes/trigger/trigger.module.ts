import { Module } from '@nestjs/common';
import { TriggerController } from './trigger.controller';
import { TriggerService } from './trigger.service';
import { TileMathHelper } from '../../helpers/tile-math.helper';

@Module({
  controllers: [TriggerController],
  providers: [TriggerService, TileMathHelper],
})
export class TriggerModule {}
