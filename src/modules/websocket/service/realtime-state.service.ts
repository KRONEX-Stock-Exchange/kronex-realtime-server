import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { OrderStatus, StockStatus } from '@prisma/client';
import Redis, { ChainableCommander } from 'ioredis';
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

    constructor(@InjectRedis() private readonly redis: Redis) {
        this.stock = new StockRealtimeState(redis);
        this.account = new AccountRealtimeState(redis);
        this.order = new OrderRealtimeState(redis);
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
    applyEvent(event: DomainEvent, outputSeq: bigint, multi: ChainableCommander): void {
        switch (event.pattern) {
            case 'stock.listed':
            case 'stock.updated':
                this.stock.applyStockUpdate(
                    {
                        id: Number(event.data.id),
                        price: BigInt(event.data.price),
                        status: event.data.status as StockStatus,
                    },
                    multi,
                );
                break;
            case 'account.updated':
            case 'account.activated':
                this.account.applyAccountUpdate(
                    {
                        id: Number(event.data.id),
                        balance: BigInt(event.data.balance),
                        availableBalance: BigInt(event.data.availableBalance),
                    },
                    multi,
                );
                break;
            case 'holding.updated':
                this.account.applyHoldingUpdate(
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
                break;
            case 'order.open':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.OPEN),
                    outputSeq,
                    multi,
                );
                break;
            case 'order.filled':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.FILLED),
                    outputSeq,
                    multi,
                );
                break;
            case 'order.canceled':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.CANCELED),
                    outputSeq,
                    multi,
                );
                break;
            case 'order.replaced':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.REPLACED),
                    outputSeq,
                    multi,
                );
                break;
            case 'order.completed':
                break;
            case 'trade.executed': {
                const trade = this.toTradeState(event.data);
                this.stock.applyStockUpdate(
                    { id: trade.stockId, price: trade.price },
                    multi,
                );
                if (this.trade.applyTrade(trade)) {
                    this.chart.applyTrade(trade);
                }
                break;
            }
            case 'orderbook.updated': {
                const stockId = Number(event.data.stockId);
                this.stock.applyOrderBookUpdate(
                    stockId,
                    event.data.levels.map((level) => ({
                        side: level.side,
                        price: BigInt(level.price),
                        quantity: BigInt(level.quantity),
                    })),
                    multi,
                );
                break;
            }
            case 'order.rejected':
                break;
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
            status,
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
