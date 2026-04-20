import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

@Global()
@Module({
  providers: [
    {
      provide: SupabaseClient,
      useFactory: (configService: ConfigService): SupabaseClient => {
        const url = configService.get<string>('supabase.url')!;
        const key = configService.get<string>('supabase.serviceRoleKey');
        return createClient(url, key!, {
          auth: { persistSession: false },
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [SupabaseClient],
})
export class SupabaseModule {}
