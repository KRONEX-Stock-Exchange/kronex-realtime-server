import { Module } from '@nestjs/common';
import { ChartSchedulerService } from './chart-scheduler.service';

@Module({
    providers: [ChartSchedulerService],
})
export class ChartRealtimeModule {}
