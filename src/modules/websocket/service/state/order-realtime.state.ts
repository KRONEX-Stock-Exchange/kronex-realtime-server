// NOTE:
// ─────────────────────────────────────────────────────────────
// Redis 키 (OrderRealtimeState)
//   rt:order:{orderId}            Hash  id, accountId, stockId, price, quantity, filledQuantity, status, tradingType, orderType?, createdAt?
//   rt:openOrders:{accountId}     ZSet  member=orderId  (score=order.id / 미체결)
//   rt:filledOrders:{accountId}   ZSet  member=orderId  (score=order.id / 체결)
//   rt:loaded:order:{accountId}   String 적재 완료 마커 (비어있는건지 DB 로드를 안한건지 구분용)
// ─────────────────────────────────────────────────────────────
import { Order, OrderStatus, OrderType, TradingType } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { RedisKeys } from 'src/modules/redis/redis-keys';
import { LOAD_ORDERS_SCRIPT } from 'src/modules/redis/redis-scripts';
import { RealtimeOrderState } from '../../type/realtime-state.type';

// 체결 주문은 최근 N개만 제공
// TODO: 체결, 미체결 주문 페이지네이션 구현이 필요함 + 정렬 (현재는 미체결 탭은 생성순(오름차순), 체결 탭은 최신순(내림차순)으로 정렬 중)
// 현재는 미체결 주문 전체 제공, 체결 주문 최대 25개 제공 중
const FILLED_ORDERS_LIMIT = 25;

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
            await this.loadOrders(order.accountId);
        }

        multi.hset(RedisKeys.order(order.id), serializeOrderFields(order));

        const openIndex = RedisKeys.openOrderIndex(order.accountId);
        const filledIndex = RedisKeys.filledOrderIndex(order.accountId);
        const score = Number(order.id);
        const member = String(order.id);

        if (order.status === OrderStatus.OPEN) {
            // 신규 주문 또는 부분 체결
            multi.zadd(openIndex, score, member);
        } else if (order.status === OrderStatus.FILLED) {
            // 전량 체결
            multi.zrem(openIndex, member);
            multi.zadd(filledIndex, score, member);
        } else {
            // 주문 취소 및 정정
            multi.zrem(openIndex, member);
            multi.zrem(filledIndex, member);
        }
    }

    // 미체결 주문 전체 조회
    async getOpenOrders(accountId: number): Promise<RealtimeOrderState[]> {
        const orderIds = await this.redis.zrange(
            RedisKeys.openOrderIndex(accountId),
            0,
            -1,
        );

        if (orderIds.length === 0) {
            if (await this.isLoaded(accountId)) return [];
            return (await this.loadOrders(accountId, true)).open;
        }

        return this.fetchOrders(orderIds);
    }

    // 체결 주문 조회
    async getFilledOrders(accountId: number): Promise<RealtimeOrderState[]> {
        const orderIds = await this.redis.zrevrange(
            RedisKeys.filledOrderIndex(accountId),
            0,
            FILLED_ORDERS_LIMIT - 1,
        );

        if (orderIds.length === 0) {
            if (await this.isLoaded(accountId)) return [];
            return (await this.loadOrders(accountId, true)).filled;
        }

        return this.fetchOrders(orderIds);
    }

    // 주문 목록이 DB로부터 완전히 적재됐는지 여부 확인
    private async isLoaded(accountId: number): Promise<boolean> {
        const loaded = await this.redis.exists(RedisKeys.orderLoaded(accountId));
        return loaded === 1;
    }

    // 주문 DB에서 조회 후 Redis 적재
    private async loadOrders(
        accountId: number,
        cacheOptional = false,
    ): Promise<{ open: RealtimeOrderState[]; filled: RealtimeOrderState[] }> {
        const rows = await this.prisma.order.findMany({
            where: {
                accountId,
                status: { in: [OrderStatus.OPEN, OrderStatus.FILLED] },
            },
            orderBy: { id: 'desc' },
        });

        const open: RealtimeOrderState[] = [];
        const filled: RealtimeOrderState[] = [];
        for (const row of rows) {
            const order = toOrderState(row);
            if (order.status === OrderStatus.OPEN) open.push(order);
            else if (filled.length < FILLED_ORDERS_LIMIT) filled.push(order);
        }

        const payload = [...open, ...filled].map((order) => ({
            id: String(order.id),
            tab: order.status === OrderStatus.OPEN ? 'o' : 'f',
            fields: serializeOrderFields(order),
        }));

        try {
            await this.redis.eval(
                LOAD_ORDERS_SCRIPT,
                3,
                RedisKeys.orderLoaded(accountId),
                RedisKeys.openOrderIndex(accountId),
                RedisKeys.filledOrderIndex(accountId),
                JSON.stringify(payload),
                'rt:order:',
            );
        } catch (error) {
            if (!cacheOptional) throw error;
        }

        return { open: [...open].reverse(), filled };
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

// DB row → 도메인 타입. 이벤트엔 없는 orderType/createdAt이 여기선 채워진다.
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
        createdAt: raw.createdAt == null ? undefined : new Date(raw.createdAt),
    };
}
