export const RedisKeys = {
    stock: (stockId: number): string => `rt:stock:${stockId}`,
    account: (accountId: number): string => `rt:account:${accountId}`,
    holding: (accountId: number, stockId: number): string =>
        `rt:holding:${accountId}:${stockId}`,
    holdingIndex: (accountId: number): string => `rt:holdings:${accountId}`,
    order: (orderId: bigint | string): string => `rt:order:${orderId}`,
    openOrderIndex: (accountId: number): string => `rt:openOrders:${accountId}`,
    filledOrderIndex: (accountId: number): string => `rt:filledOrders:${accountId}`,
    orderbook: (stockId: number): string => `rt:orderbook:${stockId}`,
    orderbookBuy: (stockId: number): string => `rt:orderbook:${stockId}:buy`,
    orderbookSell: (stockId: number): string => `rt:orderbook:${stockId}:sell`,

    orderLoaded: (accountId: number): string => `rt:loaded:order:${accountId}`,
    holdingLoaded: (accountId: number): string => `rt:loaded:holding:${accountId}`,
    orderbookLoaded: (stockId: number): string => `rt:loaded:orderbook:${stockId}`,
} as const;

export function orderBookField(side: 'BUY' | 'SELL', price: bigint | string): string {
    return `${side === 'BUY' ? 'B' : 'S'}:${price}`;
}
