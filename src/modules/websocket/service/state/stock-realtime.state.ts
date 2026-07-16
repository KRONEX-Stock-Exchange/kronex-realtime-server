import { StockStatus } from '@prisma/client';
import {
    RealtimeOrderBookLevelState,
    RealtimeOrderBookState,
    RealtimeStockInfo,
} from '../../type/realtime-state.type';

type PartialStockInfo = Pick<RealtimeStockInfo, 'id'> &
    Partial<Omit<RealtimeStockInfo, 'id'>>;

export class StockRealtimeState {
    private readonly infoById = new Map<number, PartialStockInfo>();
    private readonly orderBookByStockId = new Map<number, RealtimeOrderBookState>();

    applyStockUpdate(update: PartialStockInfo): void {
        const current = this.infoById.get(update.id);
        this.infoById.set(update.id, { ...current, ...update });
    }

    applyStockPriceUpdate(stockId: number, price: bigint): void {
        const current = this.infoById.get(stockId);
        this.infoById.set(stockId, { ...current, id: stockId, price });
    }

    getInfo(stockId: number): RealtimeStockInfo | undefined {
        const info = this.infoById.get(stockId);
        if (!info || !isCompleteStockInfo(info)) return undefined;
        return { ...info };
    }

    getPrice(stockId: number): bigint | undefined {
        return this.infoById.get(stockId)?.price;
    }

    applyOrderBookUpdate(
        stockId: number,
        outputSeq: bigint,
        levels: RealtimeOrderBookLevelState[],
    ): boolean {
        let orderBook = this.orderBookByStockId.get(stockId);
        if (orderBook && outputSeq < orderBook.outputSeq) return false;

        if (!orderBook) {
            orderBook = createEmptyOrderBook(stockId);
            this.orderBookByStockId.set(stockId, orderBook);
        }

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

    getOrderBook(stockId: number): RealtimeOrderBookState | undefined {
        const orderBook = this.orderBookByStockId.get(stockId);
        if (!orderBook) return undefined;

        return {
            ...orderBook,
            buyLevels: new Map(orderBook.buyLevels),
            sellLevels: new Map(orderBook.sellLevels),
        };
    }

    getOrderBookOutputSeq(stockId: number): bigint | undefined {
        return this.orderBookByStockId.get(stockId)?.outputSeq;
    }
}

// utill
function isCompleteStockInfo(info: PartialStockInfo): info is RealtimeStockInfo {
    return info.name != null && info.price != null && info.status != null;
}

function createEmptyOrderBook(stockId: number): RealtimeOrderBookState {
    return {
        stockId,
        outputSeq: 0n,
        buyLevels: new Map(),
        sellLevels: new Map(),
    };
}
