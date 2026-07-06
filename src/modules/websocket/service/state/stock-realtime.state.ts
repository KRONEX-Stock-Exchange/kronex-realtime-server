import { StockStatus } from '@prisma/client';
import { RealtimeStockInfo } from '../../type/realtime-state.type';

export class StockRealtimeState {
    private readonly infoById = new Map<number, RealtimeStockInfo>();

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
}
