import { Injectable } from '@nestjs/common';
import { OrderStatus, StockStatus } from '@prisma/client';
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
    readonly stock = new StockRealtimeState();
    readonly account = new AccountRealtimeState();
    readonly order = new OrderRealtimeState();
    readonly trade = new TradeRealtimeState();
    readonly chart = new ChartRealtimeState();

    applyEvent(event: DomainEvent, outputSeq?: bigint): void {
        switch (event.pattern) {
            case 'stock.listed':
            case 'stock.updated':
                this.stock.applyStockUpdate({
                    id: Number(event.data.id),
                    price: BigInt(event.data.price),
                    status: event.data.status as StockStatus,
                });
                break;
            case 'account.updated':
            case 'account.activated':
                this.account.applyAccountUpdate({
                    id: Number(event.data.id),
                    balance: BigInt(event.data.balance),
                    availableBalance: BigInt(event.data.availableBalance),
                });
                break;
            case 'holding.updated':
                this.account.applyHoldingUpdate({
                    accountId: Number(event.data.accountId),
                    stockId: Number(event.data.stockId),
                    quantity: BigInt(event.data.quantity),
                    availableQuantity: BigInt(event.data.availableQuantity),
                    average: BigInt(event.data.average),
                    totalBuyAmount: BigInt(event.data.totalBuyAmount),
                });
                break;
            case 'order.open':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.OPEN),
                );
                break;
            case 'order.filled':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.FILLED),
                );
                break;
            case 'order.canceled':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.CANCELED),
                );
                break;
            case 'order.replaced':
                this.order.applyOrderUpdate(
                    this.toOrderState(event.data, OrderStatus.REPLACED),
                );
                break;
            case 'order.completed':
                break;
            case 'trade.executed': {
                const trade = this.toTradeState(event.data);
                this.stock.applyStockPriceUpdate(trade.stockId, trade.price);
                if (this.trade.applyTrade(trade)) {
                    this.chart.applyTrade(trade);
                }
                break;
            }
            case 'orderbook.updated': {
                if (outputSeq == null) break;

                const stockId = Number(event.data.stockId);
                this.stock.applyOrderBookUpdate(
                    stockId,
                    outputSeq,
                    event.data.levels.map((level) => ({
                        side: level.side,
                        price: BigInt(level.price),
                        quantity: BigInt(level.quantity),
                    })),
                );
                break;
            }
            case 'order.rejected':
                break;
        }
    }

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
