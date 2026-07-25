// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (StockRealtimeState)
//   rt:stock:{stockId}            Hash   name, price, status
//   rt:orderbook:{stockId}        Hash   B:{price}/S:{price} = 수량
//   rt:orderbook:{stockId}:buy    ZSet   member=price  (score=price, 매수 정렬)
//   rt:orderbook:{stockId}:sell   ZSet   member=price  (score=price, 매도 정렬)
//   rt:loaded:orderbook:{stockId} String 적재 완료 마커 (비어있는건지 DB 로드를 안한건지 구분용)
// ─────────────────────────────────────────────────────────────
import { OrderStatus, StockStatus } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { RedisKeys, orderBookField } from 'src/modules/redis/redis-keys';
import {
    LOAD_ORDERBOOK_SCRIPT,
    LOAD_STOCK_SCRIPT,
} from 'src/modules/redis/redis-scripts';
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
    constructor(
        private readonly redis: Redis,
        private readonly prisma: PrismaService,
    ) {}

    // 종목 가격 조회
    async getPrice(stockId: number): Promise<bigint | undefined> {
        const price = await this.redis.hget(RedisKeys.stock(stockId), 'price');
        if (price != null) return BigInt(price);

        const info = await this.loadStock(stockId, true);

        return info.price;
    }

    // 종목 정보 조회
    async getInfo(stockId: number): Promise<RealtimeStockInfo | undefined> {
        const raw = await this.redis.hgetall(RedisKeys.stock(stockId));
        const info = parseStockInfo(stockId, raw);
        if (info && this.isCompleteStockInfo(info)) return info;

        return this.loadStock(stockId, true);
    }

    isCompleteStockInfo(info: PartialStockInfo): info is RealtimeStockInfo {
        return info.name != null && info.price != null && info.status != null;
    }

    // 종목 정보 업데이트
    async applyStockUpdate(
        update: PartialStockInfo,
        multi: ChainableCommander,
    ): Promise<void> {
        if (!(await this.isStockLoaded(update.id))) {
            await this.loadStock(update.id);
        }

        const fields = serializeStockFields(update);
        if (Object.keys(fields).length > 0) {
            multi.hset(RedisKeys.stock(update.id), fields);
        }
    }

    private async isStockLoaded(stockId: number): Promise<boolean> {
        const loaded = await this.redis.hexists(RedisKeys.stock(stockId), 'name');
        return loaded === 1;
    }

    // 종목 정보 DB에서 조회 후 Redis 적재
    private async loadStock(
        stockId: number,
        cacheOptional = false,
    ): Promise<RealtimeStockInfo | undefined> {
        const row = await this.prisma.stock.findUnique({ where: { id: stockId } });
        if (row == null) return undefined;

        try {
            await this.redis.eval(
                LOAD_STOCK_SCRIPT,
                1,
                RedisKeys.stock(stockId),
                row.name,
                String(row.price),
                row.status,
            );
        } catch (error) {
            if (!cacheOptional) throw error;
        }

        return {
            id: row.id,
            name: row.name,
            price: row.price,
            status: row.status,
        };
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
            return this.loadOrderBook(stockId, true);
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

    // 호가창 업데이트
    async applyOrderBookUpdate(
        stockId: number,
        levels: RealtimeOrderBookLevelState[],
        multi: ChainableCommander,
    ): Promise<void> {
        if (!(await this.isOrderBookLoaded(stockId))) {
            await this.loadOrderBook(stockId);
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

    // 가격 목록에 대응하는 수량을 일괄 조회 (빈 목록이면 Redis 호출 없음)
    private async fetchQuantities(
        key: string,
        side: RealtimeOrderBookSide,
        prices: string[],
    ): Promise<(string | null)[]> {
        if (prices.length === 0) return [];
        return this.redis.hmget(key, ...prices.map((p) => orderBookField(side, p)));
    }

    // 호가창이 DB로부터 완전히 적재됐는지 여부 확인
    private async isOrderBookLoaded(stockId: number): Promise<boolean> {
        const loaded = await this.redis.exists(RedisKeys.orderbookLoaded(stockId));
        return loaded === 1;
    }

    // 호가창 DB에서 조회 후 Redis 적재
    private async loadOrderBook(
        stockId: number,
        cacheOptional = false,
    ): Promise<RealtimeOrderBook> {
        const rows = await this.prisma.order.groupBy({
            by: ['tradingType', 'price'],
            where: { stockId, status: OrderStatus.OPEN },
            _sum: { quantity: true, filledQuantity: true },
        });

        const buy: RealtimeOrderBookLevel[] = [];
        const sell: RealtimeOrderBookLevel[] = [];
        for (const row of rows) {
            const remaining = (row._sum.quantity ?? 0n) - (row._sum.filledQuantity ?? 0n);
            if (remaining <= 0n) continue;

            const level = { price: row.price, quantity: remaining };
            if (row.tradingType === 'BUY') buy.push(level);
            else sell.push(level);
        }

        // 매수는 높은 가격, 매도는 낮은 가격이 상단
        buy.sort((a, b) => {
            if (a.price > b.price) return -1;
            if (a.price < b.price) return 1;
            return 0;
        });
        sell.sort((a, b) => {
            if (a.price < b.price) return -1;
            if (a.price > b.price) return 1;
            return 0;
        });

        const payload = [
            ...buy.map((level) => ({ side: 'BUY', ...serializeLevel(level) })),
            ...sell.map((level) => ({ side: 'SELL', ...serializeLevel(level) })),
        ];

        try {
            await this.redis.eval(
                LOAD_ORDERBOOK_SCRIPT,
                4,
                RedisKeys.orderbookLoaded(stockId),
                RedisKeys.orderbook(stockId),
                RedisKeys.orderbookBuy(stockId),
                RedisKeys.orderbookSell(stockId),
                JSON.stringify(payload),
            );
        } catch (error) {
            if (!cacheOptional) throw error;
        }

        return {
            buyLevels: buy.slice(0, ORDERBOOK_DEPTH),
            sellLevels: sell.slice(0, ORDERBOOK_DEPTH),
        };
    }
}

// util
// Lua 적재 payload용 직렬화 (bigint → string)
function serializeLevel(level: RealtimeOrderBookLevel): {
    price: string;
    quantity: string;
} {
    return { price: String(level.price), quantity: String(level.quantity) };
}

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
