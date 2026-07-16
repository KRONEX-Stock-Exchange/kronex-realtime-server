import { OrderStatus, OrderType, StockStatus, TradingType } from '@prisma/client';
import { ChartType } from 'src/modules/chart/type/chart-type';

export interface RealtimeStockInfo {
    id: number;
    name: string;
    price: bigint;
    status: StockStatus;
}

export interface RealtimeAccountState {
    id: number;
    balance: bigint;
    availableBalance: bigint;
    accountNumber?: number;
}

export interface RealtimeHoldingState {
    accountId: number;
    stockId: number;
    quantity: bigint;
    availableQuantity: bigint;
    average: bigint;
    totalBuyAmount: bigint;
}

export interface RealtimeOrderState {
    id: bigint;
    accountId: number;
    stockId: number;
    price: bigint;
    quantity: bigint;
    filledQuantity: bigint;
    status: OrderStatus;
    stockName?: string;
    orderType?: OrderType;
    tradingType?: TradingType;
    createdAt?: Date;
}

export interface RealtimeTradeState {
    id: bigint;
    stockId: number;
    price: bigint;
    quantity: bigint;
    makerOrderId: bigint;
    takerOrderId: bigint;
    tradingType: 'BUY' | 'SELL';
    executedAt: Date;
}

export interface RealtimeMatchedTradeState {
    price: bigint;
    quantity: bigint;
    tradingType: TradingType;
}

export type RealtimeOrderBookSide = 'BUY' | 'SELL';

export interface RealtimeOrderBookLevelState {
    side: RealtimeOrderBookSide;
    price: bigint;
    quantity: bigint;
}

export interface RealtimeOrderBookState {
    stockId: number;
    outputSeq: bigint;
    buyLevels: Map<bigint, bigint>;
    sellLevels: Map<bigint, bigint>;
}

export interface InMemoryCandle {
    candleTime: Date;
    open: bigint;
    high: bigint;
    low: bigint;
    close: bigint;
    volume: bigint;
}

export interface PendingCandle {
    stockId: number;
    type: ChartType;
    candle: InMemoryCandle;
}
