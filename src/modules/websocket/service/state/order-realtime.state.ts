// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (OrderRealtimeState)
//   rt:order:{orderId}            Hash  id, accountId, stockId, price, quantity, filledQuantity, status, tradingType, orderType?, createdAt(nullable)?, fullyFilledAt(nullable)?
//   rt:openOrders:{accountId}     ZSet  member=orderId  (score=order.id / 미체결)
//   rt:filledOrders:{accountId}   ZSet  member=orderId  (score=fullyFilledAt epoch ms, 없으면 order.id / 체결)
//   rt:loaded:order:{accountId}   String 적재 완료 마커 (비어있는건지 DB 로드를 안한건지 구분용)
// ─────────────────────────────────────────────────────────────
import { Order, OrderStatus, OrderType, TradingType } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { RedisKeys } from 'src/modules/redis/redis-keys';
import { LOAD_ORDER_INDEX_SCRIPT } from 'src/modules/redis/redis-scripts';
import { RealtimeOrderState } from '../../type/realtime-state.type';

// 커서 페이지네이션 기본 페이지 크기
const DEFAULT_ORDER_PAGE_LIMIT = 30;

export interface OrderPage {
    orders: RealtimeOrderState[];
    nextCursor: string | null;
}

export class OrderRealtimeState {
    constructor(
        private readonly redis: Redis,
        private readonly prisma: PrismaService,
    ) {}

    // 주문 탭 업데이트
    async applyOrderUpdate(
        order: RealtimeOrderState,
        multi: ChainableCommander,
    ): Promise<void> {
        if (!(await this.isLoaded(order.accountId))) {
            await this.loadOrderIndex(order.accountId);
        }

        multi.hset(RedisKeys.order(order.id), serializeOrderFields(order));

        const openIndex = RedisKeys.openOrderIndex(order.accountId);
        const filledIndex = RedisKeys.filledOrderIndex(order.accountId);
        const member = String(order.id);

        if (order.status === OrderStatus.OPEN) {
            // 신규 주문 또는 부분 체결
            multi.zadd(openIndex, Number(order.id), member);
        } else if (order.status === OrderStatus.FILLED) {
            // 전량 체결
            multi.zrem(openIndex, member);
            multi.zadd(filledIndex, filledOrderScore(order), member);
        } else {
            // 주문 취소 및 정정
            multi.zrem(openIndex, member);
            multi.zrem(filledIndex, member);
        }
    }

    // 미체결 주문 커서 페이지 조회
    // NOTE: 생성순 내림차순. 커서 = 직전 페이지 마지막 주문의 ID
    async getOpenOrders(
        accountId: number,
        cursor?: string,
        limit = DEFAULT_ORDER_PAGE_LIMIT,
    ): Promise<OrderPage> {
        if (!(await this.isLoaded(accountId))) {
            await this.loadOrderIndex(accountId, true);
        }

        const ids = await this.rangeByScore(
            RedisKeys.openOrderIndex(accountId),
            cursor,
            limit,
        );
        const orders = await this.fetchOrders(ids);
        const nextCursor =
            ids.length === limit ? String(orders[orders.length - 1].id) : null;

        return { orders, nextCursor };
    }

    // 체결 주문 커서 페이지 조회
    // NOTE: 전량체결 시각 내림차순. 커서 = 직전 페이지 마지막 주문의 fullyFilledAt 또는 ID
    async getFilledOrders(
        accountId: number,
        cursor?: string,
        limit = DEFAULT_ORDER_PAGE_LIMIT,
    ): Promise<OrderPage> {
        if (!(await this.isLoaded(accountId))) {
            await this.loadOrderIndex(accountId, true);
        }

        const ids = await this.rangeByScore(
            RedisKeys.filledOrderIndex(accountId),
            cursor,
            limit,
        );
        const orders = await this.fetchOrders(ids);
        const nextCursor =
            ids.length === limit
                ? String(filledOrderScore(orders[orders.length - 1]))
                : null;

        return { orders, nextCursor };
    }

    // 주문 목록이 DB로부터 완전히 적재됐는지 여부 확인
    private async isLoaded(accountId: number): Promise<boolean> {
        const loaded = await this.redis.exists(RedisKeys.orderLoaded(accountId));
        return loaded === 1;
    }

    // 특정 인덱스에 범위안의 데이터 조회
    private async rangeByScore(
        indexKey: string, // index
        cursor: string | undefined, // 어디서 부터 (Cursor 미포함)
        limit: number, // 가져올 최대 갯수
    ): Promise<string[]> {
        const maxScore = cursor != null ? `(${cursor}` : '+inf';

        return this.redis.zrevrangebyscore(indexKey, maxScore, '-inf', 'LIMIT', 0, limit);
    }

    // 주문 인덱스 리스트 조회
    private async loadOrderIndex(
        accountId: number,
        cacheOptional = false,
    ): Promise<void> {
        const rows = await this.prisma.order.findMany({
            where: { accountId, status: { in: [OrderStatus.OPEN, OrderStatus.FILLED] } },
            select: { id: true, status: true, fullyFilledAt: true },
        });

        const payload = rows.map((row) => ({
            id: String(row.id),
            tab: row.status === OrderStatus.OPEN ? 'o' : 'f',
            score:
                row.status === OrderStatus.OPEN ? Number(row.id) : filledOrderScore(row),
        }));

        try {
            await this.redis.eval(
                LOAD_ORDER_INDEX_SCRIPT,
                3,
                RedisKeys.orderLoaded(accountId),
                RedisKeys.openOrderIndex(accountId),
                RedisKeys.filledOrderIndex(accountId),
                JSON.stringify(payload),
            );
        } catch (error) {
            if (!cacheOptional) throw error;
        }
    }

    // ID 기반 Order 데이터 조회
    // NOTE: Redis에 없는 건 DB에서 채워서 반환
    // 캐싱 시도 (실패해도 무시)
    private async fetchOrders(orderIds: string[]): Promise<RealtimeOrderState[]> {
        if (orderIds.length === 0) return [];

        const pipeline = this.redis.pipeline();
        for (const orderId of orderIds) {
            pipeline.hgetall(RedisKeys.order(orderId));
        }
        const results = await pipeline.exec();
        if (results == null) return [];

        const orders = new Map<string, RealtimeOrderState>();
        const missingIds: string[] = [];

        results.forEach(([error, raw], index) => {
            if (error) return;
            const order = parseOrder(raw as Record<string, string>);
            if (order) {
                orders.set(orderIds[index], order);
            } else {
                missingIds.push(orderIds[index]);
            }
        });

        if (missingIds.length > 0) {
            const rows = await this.prisma.order.findMany({
                where: { id: { in: missingIds.map((id) => BigInt(id)) } },
            });

            const hydratePipeline = this.redis.pipeline();
            for (const row of rows) {
                const order = toOrderState(row);
                orders.set(String(order.id), order);
                hydratePipeline.hset(
                    RedisKeys.order(order.id),
                    serializeOrderFields(order),
                );
            }

            try {
                await hydratePipeline.exec();
            } catch {
                // 캐싱 실패는 무시 — 응답은 위에서 DB로 읽은 값 그대로 나감. 다음 요청 때 다시 캐시 미스로 재시도됨
            }
        }

        return orderIds
            .map((id) => orders.get(id))
            .filter((order): order is RealtimeOrderState => order != null);
    }
}

// utill
// 체결 ZSet 정렬 기준: fullyFilledAt, 없으면(옛날 주문 호환용) order.id로 폴백
function filledOrderScore(order: { id: bigint; fullyFilledAt: Date | null }): number {
    return order.fullyFilledAt != null ? order.fullyFilledAt.getTime() : Number(order.id);
}

function serializeOrderFields(order: RealtimeOrderState): Record<string, string> {
    const fields: Record<string, string> = {
        id: String(order.id),
        accountId: String(order.accountId),
        stockId: String(order.stockId),
        price: String(order.price),
        quantity: String(order.quantity),
        filledQuantity: String(order.filledQuantity),
        status: order.status,
        tradingType: order.tradingType,
        orderType: order.orderType,
    };

    // NOTE: 옛날 주문 호환용
    if (order.createdAt != null) fields.createdAt = order.createdAt.toISOString();

    if (order.fullyFilledAt != null)
        fields.fullyFilledAt = order.fullyFilledAt.toISOString();

    return fields;
}

// DB row → 도메인 타입
function toOrderState(row: Order): RealtimeOrderState {
    return {
        id: row.id,
        accountId: row.accountId,
        stockId: row.stockId,
        price: row.price,
        quantity: row.quantity,
        filledQuantity: row.filledQuantity,
        status: row.status,
        tradingType: row.tradingType,
        orderType: row.orderType,
        createdAt: row.createdAt,
        fullyFilledAt: row.fullyFilledAt,
    };
}

function parseOrder(raw: Record<string, string>): RealtimeOrderState | undefined {
    if (raw.id == null) return undefined;

    return {
        id: BigInt(raw.id),
        accountId: Number(raw.accountId),
        stockId: Number(raw.stockId),
        price: BigInt(raw.price),
        quantity: BigInt(raw.quantity),
        filledQuantity: BigInt(raw.filledQuantity),
        status: raw.status as OrderStatus,
        tradingType: raw.tradingType as TradingType,
        orderType: raw.orderType as OrderType | undefined,
        createdAt: raw.createdAt == null ? null : new Date(raw.createdAt),
        fullyFilledAt: raw.fullyFilledAt == null ? null : new Date(raw.fullyFilledAt),
    };
}
