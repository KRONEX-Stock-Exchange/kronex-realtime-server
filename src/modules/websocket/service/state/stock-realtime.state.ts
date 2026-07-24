// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (StockRealtimeState)
//   rt:stock:{stockId}            Hash   name, price, status
//   rt:orderbook:{stockId}        Hash   B:{price}/S:{price} = 수량
//   rt:orderbook:{stockId}:buy    ZSet   member=price  (score=price, 매수 정렬)
//   rt:orderbook:{stockId}:sell   ZSet   member=price  (score=price, 매도 정렬)
// ─────────────────────────────────────────────────────────────
import { StockStatus } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { RedisKeys, orderBookField } from 'src/modules/redis/redis-keys';
import {
    RealtimeOrderBook,
    RealtimeOrderBookLevel,
    RealtimeOrderBookLevelState,
    RealtimeOrderBookSide,
    RealtimeStockInfo,
} from '../../type/realtime-state.type';

type PartialStockInfo = Pick<RealtimeStockInfo, 'id'> &
    Partial<Omit<RealtimeStockInfo, 'id'>>;

// 호가창 표시 깊이 (한 방향 상위 N개)
const ORDERBOOK_DEPTH = 10;

export class StockRealtimeState {
    constructor(private readonly redis: Redis) {}

    // 종목 가격 조회
    async getPrice(stockId: number): Promise<bigint | undefined> {
        const price = await this.redis.hget(RedisKeys.stock(stockId), 'price');
        return price == null ? undefined : BigInt(price);
    }

    // 종목 정보 조회
    async getInfo(stockId: number): Promise<RealtimeStockInfo | undefined> {
        const raw = await this.redis.hgetall(RedisKeys.stock(stockId));
        const info = parseStockInfo(stockId, raw);
        if (!info || !isCompleteStockInfo(info)) return undefined;
        return info;
    }

    // 종목 정보 업데이트
    applyStockUpdate(update: PartialStockInfo, multi: ChainableCommander): void {
        const fields = serializeStockFields(update);
        if (Object.keys(fields).length > 0) {
            multi.hset(RedisKeys.stock(update.id), fields);
        }
    }

    // 호가창 조회
    async getOrderBook(stockId: number): Promise<RealtimeOrderBook | undefined> {
        // 표시할 호가 깊이 만큼 양 호가 가격대 조회
        const rangePipe = this.redis.pipeline();
        rangePipe.zrevrange(RedisKeys.orderbookBuy(stockId), 0, ORDERBOOK_DEPTH - 1);
        rangePipe.zrange(RedisKeys.orderbookSell(stockId), 0, ORDERBOOK_DEPTH - 1);
        const rangeRes = await rangePipe.exec();
        if (rangeRes == null) return undefined;

        const [buyError, buyRaw] = rangeRes[0];
        const [sellError, sellRaw] = rangeRes[1];
        if (buyError) throw buyError;
        if (sellError) throw sellError;

        const buyPrices = buyRaw as string[];
        const sellPrices = sellRaw as string[];

        if (buyPrices.length === 0 && sellPrices.length === 0) {
            if (await this.isOrderBookLoaded(stockId)) return undefined;

            // TODO: 여기서 Lua 실행
            // DB에서 status=OPEN 주문을 가격별로 집계해 적재하고 loaded 마커를 세팅한 뒤 반환한다.
            // 쓰기 경로도 같은 적재를 시도하므로, Lua 내부에서 loaded를 재검증해 경쟁을 막는다.
            return undefined;
        }

        // 각 가격대 수량 조회
        const key = RedisKeys.orderbook(stockId);
        const [buyQtys, sellQtys] = await Promise.all([
            this.fetchQuantities(key, 'BUY', buyPrices),
            this.fetchQuantities(key, 'SELL', sellPrices),
        ]);

        return {
            buyLevels: zipLevels(buyPrices, buyQtys),
            sellLevels: zipLevels(sellPrices, sellQtys),
        };
    }

    // 가격 목록에 대응하는 수량을 일괄 조회 (빈 목록이면 Redis 호출 없음)
    private async fetchQuantities(
        key: string,
        side: RealtimeOrderBookSide,
        prices: string[],
    ): Promise<(string | null)[]> {
        if (prices.length === 0) return [];
        return this.redis.hmget(key, ...prices.map((p) => orderBookField(side, p)));
    }

    private async isOrderBookLoaded(stockId: number): Promise<boolean> {
        const loaded = await this.redis.exists(RedisKeys.orderbookLoaded(stockId));
        return loaded === 1;
    }

    // 호가창 업데이트
    async applyOrderBookUpdate(
        stockId: number,
        levels: RealtimeOrderBookLevelState[],
        multi: ChainableCommander,
    ): Promise<void> {
        if (!(await this.isOrderBookLoaded(stockId))) {
            // TODO: 여기서 Lua 실행
            // DB에서 status=OPEN 주문을 가격별로 집계해 적재하고 loaded 마커를 세팅한다.
            // 읽기 경로도 같은 적재를 시도하므로, Lua 내부에서 loaded를 재검증해 경쟁을 막는다.
        }

        const key = RedisKeys.orderbook(stockId);

        for (const level of levels) {
            const field = orderBookField(level.side, level.price);
            const zsetKey =
                level.side === 'BUY'
                    ? RedisKeys.orderbookBuy(stockId)
                    : RedisKeys.orderbookSell(stockId);
            const member = String(level.price);

            if (level.quantity === 0n) {
                multi.hdel(key, field);
                multi.zrem(zsetKey, member);
            } else {
                multi.hset(key, field, String(level.quantity));
                multi.zadd(zsetKey, Number(level.price), member);
            }
        }
    }
}

// util
function serializeStockFields(update: PartialStockInfo): Record<string, string> {
    const fields: Record<string, string> = {};
    if (update.name != null) fields.name = update.name;
    if (update.price != null) fields.price = String(update.price);
    if (update.status != null) fields.status = update.status;
    return fields;
}

function parseStockInfo(
    stockId: number,
    raw: Record<string, string>,
): PartialStockInfo | undefined {
    if (Object.keys(raw).length === 0) return undefined;
    return {
        id: stockId,
        name: raw.name,
        price: raw.price == null ? undefined : BigInt(raw.price),
        status: raw.status as StockStatus | undefined,
    };
}

function isCompleteStockInfo(info: PartialStockInfo): info is RealtimeStockInfo {
    return info.name != null && info.price != null && info.status != null;
}

// 정렬된 가격 배열 + 대응 수량 배열을 레벨 배열로 조립 (수량 누락분은 스킵)
function zipLevels(
    prices: string[],
    quantities: (string | null)[],
): RealtimeOrderBookLevel[] {
    const levels: RealtimeOrderBookLevel[] = [];
    for (let i = 0; i < prices.length; i++) {
        const quantity = quantities[i];
        if (quantity == null) continue;
        levels.push({ price: BigInt(prices[i]), quantity: BigInt(quantity) });
    }
    return levels;
}
