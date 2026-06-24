import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './common/prisma/prisma.module';
import { WebsocketModule } from './modules/websocket/websocket.module';
import { ChartRealtimeModule } from './modules/chart/chart-realtime.module';
import config from './config/config';

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: '.env',
            isGlobal: true,
            load: [config],
        }),
        ScheduleModule.forRoot(),
        PrismaModule,
        ChartRealtimeModule,
        WebsocketModule,
    ],
})
export class AppModule {}
