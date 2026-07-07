import { StockStatus } from '@prisma/client';
import {
    RealtimeOrderBookLevelState,
    RealtimeOrderBookState,
    RealtimeStockInfo,
} from '../../type/realtime-state.type';

export class StockRealtimeState {
    private readonly infoById = new Map<number, RealtimeStockInfo>();
    private readonly orderBookByStockId = new Map<number, RealtimeOrderBookState>();

    setInfo(info: RealtimeStockInfo): void {
        this.infoById.set(info.id, info);
    }

    updateInfo(update: { id: number; price: bigint; status: StockStatus }): void {
        const info = this.infoById.get(update.id);
        if (info) this.infoById.set(update.id, { ...info, ...update });
    }

    updatePrice(stockId: number, price: bigint): void {
        const info = this.infoById.get(stockId);
        if (info) this.infoById.set(stockId, { ...info, price });
    }

    getInfo(stockId: number): RealtimeStockInfo | undefined {
        return this.infoById.get(stockId);
    }

    setOrderBook(orderBook: RealtimeOrderBookState): void {
        this.orderBookByStockId.set(orderBook.stockId, orderBook);
    }

    getOrderBook(stockId: number): RealtimeOrderBookState | undefined {
        return this.orderBookByStockId.get(stockId);
    }

    applyOrderBookUpdate(
        stockId: number,
        outputSeq: bigint,
        levels: RealtimeOrderBookLevelState[],
    ): boolean {
        const orderBook = this.orderBookByStockId.get(stockId);
        if (!orderBook || outputSeq <= orderBook.outputSeq) return false;

        for (const level of levels) {
            const sideLevels =
                level.side === 'BUY' ? orderBook.buyLevels : orderBook.sellLevels;

            if (level.quantity === 0n) {
                sideLevels.delete(level.price);
            } else {
                sideLevels.set(level.price, level.quantity);
            }
        }

        orderBook.outputSeq = outputSeq;
        return true;
    }
}
