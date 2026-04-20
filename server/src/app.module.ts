import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { configuration } from './config';
import { envSchema } from './config/env.validation';
import { SharedModule } from './shared.module';
import { SupabaseModule } from './supabase.module';
import { TriggerModule } from './routes/trigger/trigger.module';
import { IngestionModule } from './routes/ingestion/ingestion.module';
import { DebugModule } from './routes/debug/debug.module';
import { WorkerModule } from './routes/worker/worker.module';
import { EventsModule } from './routes/events/events.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: (config) => envSchema.parse(config),
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 3,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 20,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 100,
      },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        level: 'info',
        autoLogging: true,
      },
    }),
    SharedModule,
    SupabaseModule,
    TriggerModule,
    IngestionModule,
    DebugModule,
    WorkerModule,
    EventsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
