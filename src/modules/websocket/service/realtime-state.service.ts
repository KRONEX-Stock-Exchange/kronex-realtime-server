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

    applyEvent(event: DomainEvent): void {
        switch (event.pattern) {
            case 'stock.listed':
            case 'stock.updated':
                this.stock.updateInfo({
                    id: Number(event.data.id),
                    price: BigInt(event.data.price),
                    status: event.data.status as StockStatus,
                });
                break;
            case 'account.updated':
            case 'account.activated':
                this.account.setAccount({
                    id: Number(event.data.id),
                    balance: BigInt(event.data.balance),
                    availableBalance: BigInt(event.data.availableBalance),
                });
                break;
            case 'holding.updated':
                this.account.setHolding({
                    accountId: Number(event.data.accountId),
                    stockId: Number(event.data.stockId),
                    quantity: BigInt(event.data.quantity),
                    availableQuantity: BigInt(event.data.availableQuantity),
                    average: BigInt(event.data.average),
                    totalBuyAmount: BigInt(event.data.totalBuyAmount),
                });
                break;
            case 'order.open':
                this.order.set(this.toOrderState(event.data, OrderStatus.OPEN));
                break;
            case 'order.filled':
                this.order.set(this.toOrderState(event.data, OrderStatus.FILLED));
                break;
            case 'order.canceled':
                this.order.set(this.toOrderState(event.data, OrderStatus.CANCELED));
                break;
            case 'trade.executed': {
                const trade = this.toTradeState(event.data);
                this.stock.updatePrice(trade.stockId, trade.price);
                if (this.trade.add(trade)) {
                    this.chart.applyTrade(trade);
                }
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
            id: BigInt(data.orderId),
            accountId: Number(data.accountId),
            stockId: Number(data.stockId),
            price: BigInt(data.price),
            quantity: BigInt(data.quantity),
            filledQuantity: BigInt(data.filledQuantity),
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
            executedAt: new Date(data.executedAt),
        };
    }
}
