// NOTE: 이 파일은 서버가 다루는 내부 도메인의 타입을 정의합니다.

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
    tradingType: TradingType;
    orderType: OrderType;

    // NOTE: 아래 두 타입은 포함되어야하지만 현재 Engine에서 데이터를 누락하여
    // 보내 주고 있어 임시 Optional 처리 함
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

export interface RealtimeOrderBookLevel {
    price: bigint;
    quantity: bigint;
}

export interface RealtimeOrderBook {
    buyLevels: RealtimeOrderBookLevel[];
    sellLevels: RealtimeOrderBookLevel[];
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
