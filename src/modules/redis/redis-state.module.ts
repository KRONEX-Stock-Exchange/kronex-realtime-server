import { Global, Module } from '@nestjs/common';
import { RedisStateService } from './redis-state.service';

@Global()
@Module({
    providers: [RedisStateService],
    exports: [RedisStateService],
})
export class RedisStateModule {}
