// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (AccountRealtimeState)
//   rt:account:{accountId}              Hash  id, balance, availableBalance, accountNumber?, userId?
//   rt:holding:{accountId}:{stockId}    Hash  quantity, availableQuantity, average, totalBuyAmount
//   rt:holdings:{accountId}             Set   member=stockId (보유 종목 인덱스)
// ─────────────────────────────────────────────────────────────
import Redis, { ChainableCommander } from 'ioredis';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { RedisKeys } from 'src/modules/redis/redis-keys';
import { LOAD_HOLDINGS_SCRIPT } from 'src/modules/redis/redis-scripts';
import {
    RealtimeAccountState,
    RealtimeHoldingState,
} from '../../type/realtime-state.type';

type AccountState = RealtimeAccountState & {
    userId?: number;
};

export class AccountRealtimeState {
    constructor(
        private readonly redis: Redis,
        private readonly prisma: PrismaService,
    ) {}

    // 계좌 조회
    async getAccount(accountId: number): Promise<AccountState | undefined> {
        const raw = await this.redis.hgetall(RedisKeys.account(accountId));
        return parseAccount(accountId, raw);
    }

    // 계좌 정보 업데이트
    applyAccountUpdate(account: AccountState, multi: ChainableCommander): void {
        multi.hset(RedisKeys.account(account.id), serializeAccountFields(account));
    }

    // 특정 종목 보유 현황 조회
    async getHolding(
        accountId: number,
        stockId: number,
    ): Promise<RealtimeHoldingState | undefined> {
        const raw = await this.redis.hgetall(RedisKeys.holding(accountId, stockId));
        const holding = parseHolding(accountId, stockId, raw);

        if (holding == null) {
            if (await this.isHoldingLoaded(accountId)) return undefined;

            const holdings = await this.loadHoldings(accountId, true);
            return holdings.find((item) => item.stockId === stockId);
        }

        return holding;
    }

    // 보유 종목 전체 조회
    async getHoldings(accountId: number): Promise<RealtimeHoldingState[]> {
        const stockIds = await this.redis.smembers(RedisKeys.holdingIndex(accountId));

        if (stockIds.length === 0) {
            if (await this.isHoldingLoaded(accountId)) return [];
            return this.loadHoldings(accountId, true);
        }

        const pipeline = this.redis.pipeline();
        for (const stockId of stockIds) {
            pipeline.hgetall(RedisKeys.holding(accountId, Number(stockId)));
        }
        const results = await pipeline.exec();
        if (results == null) return [];

        const holdings: RealtimeHoldingState[] = [];
        results.forEach(([error, raw], index) => {
            if (error) return;
            const holding = parseHolding(
                accountId,
                Number(stockIds[index]),
                raw as Record<string, string>,
            );
            if (holding) holdings.push(holding);
        });

        return holdings;
    }

    // 보유 종목이 DB로부터 완전히 적재됐는지 여부 확인
    private async isHoldingLoaded(accountId: number): Promise<boolean> {
        const loaded = await this.redis.exists(RedisKeys.holdingLoaded(accountId));
        return loaded === 1;
    }

    // 보유 종목 DB에서 조회 후 Redis 적재
    private async loadHoldings(
        accountId: number,
        cacheOptional = false,
    ): Promise<RealtimeHoldingState[]> {
        const rows = await this.prisma.userStock.findMany({ where: { accountId } });
        const holdings = rows.map((row) => ({
            accountId: row.accountId,
            stockId: row.stockId,
            quantity: row.quantity,
            availableQuantity: row.availableQuantity,
            average: row.average,
            totalBuyAmount: row.totalBuyAmount,
        }));

        const payload = holdings.map((holding) => ({
            stockId: String(holding.stockId),
            fields: serializeHoldingFields(holding),
        }));

        try {
            await this.redis.eval(
                LOAD_HOLDINGS_SCRIPT,
                2,
                RedisKeys.holdingLoaded(accountId),
                RedisKeys.holdingIndex(accountId),
                JSON.stringify(payload),
                `rt:holding:${accountId}:`,
            );
        } catch (error) {
            if (!cacheOptional) throw error;
        }

        return holdings;
    }

    // 종목 보유 현황 업데이트
    async applyHoldingUpdate(
        holding: RealtimeHoldingState,
        multi: ChainableCommander,
    ): Promise<void> {
        if (!(await this.isHoldingLoaded(holding.accountId))) {
            await this.loadHoldings(holding.accountId);
        }

        const key = RedisKeys.holding(holding.accountId, holding.stockId);
        const indexKey = RedisKeys.holdingIndex(holding.accountId);

        if (holding.quantity === 0n && holding.availableQuantity === 0n) {
            multi.del(key);
            multi.srem(indexKey, String(holding.stockId));

            return;
        }

        multi.hset(key, serializeHoldingFields(holding));
        multi.sadd(indexKey, String(holding.stockId));
    }
}

// util
function serializeAccountFields(account: AccountState): Record<string, string> {
    const fields: Record<string, string> = {
        id: String(account.id),
        balance: String(account.balance),
        availableBalance: String(account.availableBalance),
    };
    if (account.accountNumber != null) {
        fields.accountNumber = String(account.accountNumber);
    }
    if (account.userId != null) fields.userId = String(account.userId);

    return fields;
}

function serializeHoldingFields(holding: RealtimeHoldingState): Record<string, string> {
    return {
        accountId: String(holding.accountId),
        stockId: String(holding.stockId),
        quantity: String(holding.quantity),
        availableQuantity: String(holding.availableQuantity),
        average: String(holding.average),
        totalBuyAmount: String(holding.totalBuyAmount),
    };
}

// NOTE: 아래 변환 함수들은 Pass-Through이기에 굳이 변환할 필요는 없지만 다른 도메인과의 일관성을 위해서
// 유지 함 추후 제거가 필요하면 제거해도 됨
function parseAccount(
    accountId: number,
    raw: Record<string, string>,
): AccountState | undefined {
    if (raw.balance == null || raw.availableBalance == null) return undefined;

    return {
        id: accountId,
        balance: BigInt(raw.balance),
        availableBalance: BigInt(raw.availableBalance),
        accountNumber: raw.accountNumber == null ? undefined : Number(raw.accountNumber),
        userId: raw.userId == null ? undefined : Number(raw.userId),
    };
}

function parseHolding(
    accountId: number,
    stockId: number,
    raw: Record<string, string>,
): RealtimeHoldingState | undefined {
    if (raw.quantity == null) return undefined;

    return {
        accountId,
        stockId,
        quantity: BigInt(raw.quantity),
        availableQuantity: BigInt(raw.availableQuantity),
        average: BigInt(raw.average),
        totalBuyAmount: BigInt(raw.totalBuyAmount),
    };
}
