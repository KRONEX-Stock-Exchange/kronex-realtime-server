import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

// TODO: 이벤트 큐 소비는 직렬로 이루어져야 함으로 추후 RT 서버 확장시 한개의 서버만
// 쓰기 권한을 가지도록 관련 로직을 추가 해야함.
@Injectable()
export class RedisStateService implements OnModuleInit {
    private readonly logger = new Logger(RedisStateService.name);

    private static readonly META_KEY = 'rt:meta';
    private static readonly CURSOR_FIELD = 'cursor';

    private cursor = 0n;

    constructor(@InjectRedis() private readonly redis: Redis) {}

    async onModuleInit(): Promise<void> {
        await this.loadCursor();
    }

    private async loadCursor(): Promise<void> {
        const raw = await this.redis.hget(
            RedisStateService.META_KEY,
            RedisStateService.CURSOR_FIELD,
        );
        this.cursor = raw ? BigInt(raw) : 0n;
        this.logger.log(`Redis cursor 로드 완료 (cursor=${this.cursor})`);
    }

    getCursor(): bigint {
        return this.cursor;
    }

    async commitCursor(outputSeq: bigint): Promise<void> {
        await this.redis.hset(
            RedisStateService.META_KEY,
            RedisStateService.CURSOR_FIELD,
            String(outputSeq),
        );

        this.cursor = outputSeq;
    }
}
