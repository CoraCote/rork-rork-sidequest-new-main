import { Global, Module } from '@nestjs/common';
import { NormalizeHelper } from './helpers/normalize.helper';
import { GeoHelper } from './helpers/geo.helper';

@Global()
@Module({
  providers: [NormalizeHelper, GeoHelper],
  exports: [NormalizeHelper, GeoHelper],
})
export class SharedModule {}
