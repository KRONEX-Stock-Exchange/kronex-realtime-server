// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (OrderRealtimeState)
//   rt:order:{orderId}            Hash  id, accountId, stockId, price, quantity, filledQuantity, status, tradingType, orderType?, createdAt?
//   rt:openOrders:{accountId}     ZSet  member=orderId  (score=order.id, 생성순 / 미체결)
//   rt:filledOrders:{accountId}   ZSet  member=orderId  (score=outputSeq, 체결순 / 체결)
// ─────────────────────────────────────────────────────────────
import { OrderStatus, OrderType, TradingType } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { RedisKeys } from 'src/modules/redis/redis-keys';
import { RealtimeOrderState } from '../../type/realtime-state.type';

// 체결 주문은 최근 N개만 제공
// TODO: 체결, 미체결 주문 페이지네이션 구현이 필요함
// 현재는 미체결 주문 전체 제공, 체결 주문 최대 25개 제공 중
const FILLED_ORDERS_LIMIT = 25;

export class OrderRealtimeState {
    constructor(private readonly redis: Redis) {}

    // 주문 탭 업데이트
    applyOrderUpdate(
        order: RealtimeOrderState,
        outputSeq: bigint, // 체결탭 정렬용
        multi: ChainableCommander,
    ): void {
        multi.hset(RedisKeys.order(order.id), serializeOrderFields(order));

        const openIndex = RedisKeys.openOrderIndex(order.accountId);
        const filledIndex = RedisKeys.filledOrderIndex(order.accountId);

        if (order.status === OrderStatus.OPEN) {
            // 신규 주문 또는 부분 체결
            multi.zadd(openIndex, Number(order.id), String(order.id));
        } else if (order.status === OrderStatus.FILLED) {
            // 전량 체결
            multi.zrem(openIndex, String(order.id));
            multi.zadd(filledIndex, Number(outputSeq), String(order.id));
        } else {
            // 주문 취소 및 정정
            multi.zrem(openIndex, String(order.id));
            multi.zrem(filledIndex, String(order.id));
        }
    }

    // 미체결 주문 전체 조회
    async getOpenOrders(accountId: number): Promise<RealtimeOrderState[]> {
        const orderIds = await this.redis.zrange(
            RedisKeys.openOrderIndex(accountId),
            0,
            -1,
        );
        return this.fetchOrders(orderIds);
    }

    // 체결 주문 조회
    async getFilledOrders(accountId: number): Promise<RealtimeOrderState[]> {
        const orderIds = await this.redis.zrevrange(
            RedisKeys.filledOrderIndex(accountId),
            0,
            FILLED_ORDERS_LIMIT - 1,
        );
        return this.fetchOrders(orderIds);
    }

    // ID 기반 Order 데이터 조회
    private async fetchOrders(orderIds: string[]): Promise<RealtimeOrderState[]> {
        if (orderIds.length === 0) return [];

        const pipeline = this.redis.pipeline();
        for (const orderId of orderIds) {
            pipeline.hgetall(RedisKeys.order(orderId));
        }
        const results = await pipeline.exec();
        if (results == null) return [];

        const orders: RealtimeOrderState[] = [];
        for (const [error, raw] of results) {
            if (error) continue;
            const order = parseOrder(raw as Record<string, string>);
            if (order) orders.push(order);
        }

        return orders;
    }
}

// utill
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
    };

    if (order.orderType != null) fields.orderType = order.orderType;
    if (order.createdAt != null) fields.createdAt = order.createdAt.toISOString();

    return fields;
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
        createdAt: raw.createdAt == null ? undefined : new Date(raw.createdAt),
    };
}
