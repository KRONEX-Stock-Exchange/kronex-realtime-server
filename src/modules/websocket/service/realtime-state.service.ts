import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { OrderStatus, StockStatus } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
import { PrismaService } from 'src/common/prisma/prisma.service';
import {
    DomainEvent,
    OrderLifecycleEventData,
    TradeExecutedEventData,
} from '../type/event.type';
import { RealtimeOrderState, RealtimeTradeState } from '../type/realtime-state.type';
import { AccountRealtimeState } from './state/account-realtime.state';
import { ChartRealtimeState } from './state/chart-realtime.state';
import { OrderRealtimeState } from './state/order-realtime.state';
import { StockRealtimeState } from './state/stock-realtime.state';
import { TradeRealtimeState } from './state/trade-realtime.state';

@Injectable()
export class RealtimeStateService {
    // Redis
    readonly stock: StockRealtimeState;
    readonly account: AccountRealtimeState;
    readonly order: OrderRealtimeState;

    // InMemory
    // TODO: Redis로 옮기기
    readonly trade = new TradeRealtimeState();
    readonly chart = new ChartRealtimeState();

    constructor(
        @InjectRedis() private readonly redis: Redis,
        prisma: PrismaService,
    ) {
        this.stock = new StockRealtimeState(redis, prisma);
        this.account = new AccountRealtimeState(redis, prisma);
        this.order = new OrderRealtimeState(redis, prisma);
    }

    // Redis Transaction 생성
    createBatch(): ChainableCommander {
        return this.redis.multi();
    }

    // Redis Transaction 커밋
    async commitBatch(multi: ChainableCommander): Promise<void> {
        const results = await multi.exec();
        if (results == null) {
            throw new Error('Redis MULTI/EXEC aborted');
        }
        for (const [error] of results) {
            if (error) throw error;
        }
    }

    // 이벤트 State 상태 반영 함수
    // NOTE: 주문 관련 이벤트면 반영한 주문 상태를 돌려줌
    async applyEvent(
        event: DomainEvent,
        multi: ChainableCommander,
    ): Promise<RealtimeOrderState | undefined> {
        switch (event.pattern) {
            case 'stock.listed':
            case 'stock.updated':
                await this.stock.applyStockUpdate(
                    {
                        id: Number(event.data.id),
                        price: BigInt(event.data.price),
                        status: event.data.status as StockStatus,
                    },
                    multi,
                );
                return undefined;
            case 'account.updated':
            case 'account.activated':
                await this.account.applyAccountUpdate(
                    {
                        id: Number(event.data.id),
                        balance: BigInt(event.data.balance),
                        availableBalance: BigInt(event.data.availableBalance),
                    },
                    multi,
                );
                return undefined;
            case 'holding.updated':
                await this.account.applyHoldingUpdate(
                    {
                        accountId: Number(event.data.accountId),
                        stockId: Number(event.data.stockId),
                        quantity: BigInt(event.data.quantity),
                        availableQuantity: BigInt(event.data.availableQuantity),
                        average: BigInt(event.data.average),
                        totalBuyAmount: BigInt(event.data.totalBuyAmount),
                    },
                    multi,
                );
                return undefined;
            case 'order.open':
            case 'order.filled':
            case 'order.canceled':
            case 'order.replaced': {
                const statusMap: Record<typeof event.pattern, OrderStatus> = {
                    'order.open': OrderStatus.OPEN,
                    'order.filled': OrderStatus.FILLED,
                    'order.canceled': OrderStatus.CANCELED,
                    'order.replaced': OrderStatus.REPLACED,
                };
                const order = this.toOrderState(event.data, statusMap[event.pattern]);
                await this.order.applyOrderUpdate(order, multi);
                return order;
            }
            case 'order.completed':
                return undefined;
            case 'trade.executed': {
                const trade = this.toTradeState(event.data);
                await this.stock.applyStockUpdate(
                    { id: trade.stockId, price: trade.price },
                    multi,
                );
                if (this.trade.applyTrade(trade)) {
                    this.chart.applyTrade(trade);
                }
                return undefined;
            }
            case 'orderbook.updated': {
                const stockId = Number(event.data.stockId);
                await this.stock.applyOrderBookUpdate(
                    stockId,
                    event.data.levels.map((level) => ({
                        side: level.side,
                        price: BigInt(level.price),
                        quantity: BigInt(level.quantity),
                    })),
                    multi,
                );
                return undefined;
            }
            case 'order.rejected':
                return undefined;
        }
    }

    // Util
    private toOrderState(
        data: OrderLifecycleEventData,
        status: OrderStatus,
    ): RealtimeOrderState {
        return {
            id: BigInt(data.id),
            accountId: Number(data.accountId),
            stockId: Number(data.stockId),
            price: BigInt(data.price),
            quantity: BigInt(data.quantity),
            filledQuantity: BigInt(data.filledQuantity),
            tradingType: data.tradingType,
            orderType: data.orderType,
            status,
            createdAt: data.createdAt != null ? new Date(data.createdAt) : null,
            fullyFilledAt:
                data.fullyFilledAt != null ? new Date(data.fullyFilledAt) : null,
        };
    }

    private toTradeState(data: TradeExecutedEventData): RealtimeTradeState {
        return {
            id: BigInt(data.id),
            stockId: Number(data.stockId),
            price: BigInt(data.price),
            quantity: BigInt(data.quantity),
            makerOrderId: BigInt(data.makerOrderId),
            takerOrderId: BigInt(data.takerOrderId),
            tradingType: data.tradingType,
            executedAt: new Date(data.executedAt),
        };
    }
}
