import { Module } from '@nestjs/common';
import { RedisModule } from '@nestjs-modules/ioredis';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './common/prisma/prisma.module';
import { WebsocketModule } from './modules/websocket/websocket.module';
import { ChartRealtimeModule } from './modules/chart/chart-realtime.module';
import { RedisStateModule } from './modules/redis/redis-state.module';
import config from './config/config';

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: '.env',
            isGlobal: true,
            load: [config],
        }),
        RedisModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                type: 'single',
                url: configService.getOrThrow<string>('REDIS_URL'),
            }),
        }),
        ScheduleModule.forRoot(),
        RedisStateModule,
        PrismaModule,
        ChartRealtimeModule,
        WebsocketModule,
    ],
})
export class AppModule {}
