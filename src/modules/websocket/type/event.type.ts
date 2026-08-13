// NOTE: 이 파일은 MQ로 부터 받은 데이터의 타입을 정의합니다.

export interface EventBatch {
    inputSeq: number;
    outputSeq: number;
    createdAt: string;
    events: DomainEvent[];
}

// pattern으로 판별하는 discriminated union (consumer switch에서 자동 타입 좁힘)
export type DomainEvent =
    | { pattern: 'trade.executed'; data: TradeExecutedEventData }
    | { pattern: 'order.open'; data: OrderLifecycleEventData }
    | { pattern: 'order.filled'; data: OrderLifecycleEventData }
    | { pattern: 'order.canceled'; data: OrderLifecycleEventData }
    | { pattern: 'order.replaced'; data: OrderLifecycleEventData }
    | { pattern: 'order.completed'; data: OrderLifecycleEventData }
    | { pattern: 'order.rejected'; data: OrderRejectedEventData }
    | { pattern: 'account.updated'; data: AccountBalanceEventData }
    | { pattern: 'account.activated'; data: AccountBalanceEventData }
    | { pattern: 'holding.updated'; data: HoldingUpdatedEventData }
    | { pattern: 'orderbook.updated'; data: OrderBookUpdatedEventData }
    | { pattern: 'stock.listed'; data: StockStateEventData }
    | { pattern: 'stock.updated'; data: StockStateEventData };

export type EventName = DomainEvent['pattern'];

// trade.executed — 체결 내역
export interface TradeExecutedEventData {
    id: string;
    stockId: string;
    price: string;
    quantity: string;
    makerOrderId: string;
    takerOrderId: string;
    tradingType: 'BUY' | 'SELL';
    executedAt: string;
}

// order.open / filled / canceled / replaced / completed — 주문 상태 전이
export interface OrderLifecycleEventData {
    id: string;
    targetId: string;
    accountId: string;
    stockId: string;
    price: string;
    tradingType: 'BUY' | 'SELL' | 'EDIT' | 'CANCEL';
    orderType: 'LIMIT' | 'MARKET';
    quantity: string;
    filledQuantity: string;
    createdAt: string | null;
    fullyFilledAt: string | null;
}

// order.rejected — 유효성 검사 실패로 거부
export interface OrderRejectedEventData {
    orderId: string;
    reason:
        | 'INVALID_ORDER'
        | 'INSUFFICIENT_BALANCE'
        | 'INSUFFICIENT_STOCK'
        | 'STOCK_NOT_TRADABLE'
        | 'ORDER_NOT_ACTIVE';
}

// account.updated / account.activated — 계좌 잔고/활성화
export interface AccountBalanceEventData {
    id: string;
    balance: string;
    availableBalance: string;
}

// holding.updated — 보유종목 변동
export interface HoldingUpdatedEventData {
    accountId: string;
    stockId: string;
    quantity: string;
    availableQuantity: string;
    average: string;
    totalBuyAmount: string;
}

export interface OrderBookUpdatedEventData {
    stockId: string;
    levels: OrderBookUpdatedLevelEventData[];
}

export interface OrderBookUpdatedLevelEventData {
    side: 'BUY' | 'SELL';
    price: string;
    quantity: string;
}

export interface StockStateEventData {
    id: string;
    price: string;
    status: 'LISTED' | 'SUSPENDED' | 'DELISTED' | 'PENDING';
}
