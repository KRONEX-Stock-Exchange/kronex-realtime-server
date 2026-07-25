import { ChartType, CHART_TYPES } from 'src/modules/chart/type/chart-type';
import {
    InMemoryCandle,
    PendingCandle,
    RealtimeTradeState,
} from '../../type/realtime-state.type';

// TODO: Redis 적용하기
export class ChartRealtimeState {
    private readonly currentCandles = new Map<string, InMemoryCandle>();
    private pendingCandles: PendingCandle[] = [];

    applyTrade(trade: RealtimeTradeState): void {
        for (const type of CHART_TYPES) {
            const key = this.key(trade.stockId, type);
            const candleTime = this.getCandleTime(trade.executedAt, type);
            const existing = this.currentCandles.get(key);

            if (!existing || existing.candleTime.getTime() !== candleTime.getTime()) {
                if (existing) {
                    this.pendingCandles.push({
                        stockId: trade.stockId,
                        type,
                        candle: existing,
                    });
                }
                this.currentCandles.set(key, {
                    candleTime,
                    open: trade.price,
                    high: trade.price,
                    low: trade.price,
                    close: trade.price,
                    volume: trade.quantity,
                });
                continue;
            }

            if (trade.price > existing.high) existing.high = trade.price;
            if (trade.price < existing.low) existing.low = trade.price;
            existing.close = trade.price;
            existing.volume += trade.quantity;
        }
    }

    getCurrentCandle(stockId: number, type: ChartType): InMemoryCandle | undefined {
        return this.currentCandles.get(this.key(stockId, type));
    }

    setCurrentCandle(stockId: number, type: ChartType, candle: InMemoryCandle): void {
        this.currentCandles.set(this.key(stockId, type), candle);
    }

    getPendingCandles(): readonly PendingCandle[] {
        return this.pendingCandles;
    }

    drainPendingCandles(): PendingCandle[] {
        const pending = this.pendingCandles;
        this.pendingCandles = [];
        return pending;
    }

    returnPendingCandles(candles: PendingCandle[]): void {
        this.pendingCandles = [...candles, ...this.pendingCandles];
    }

    flushDayCandles(): void {
        for (const [key, candle] of this.currentCandles.entries()) {
            if (!key.endsWith(':1d')) continue;
            const stockId = Number(key.split(':')[0]);
            this.pendingCandles.push({ stockId, type: '1d', candle });
            this.currentCandles.delete(key);
        }
    }

    getCandleTime(matchedAt: Date, type: ChartType): Date {
        const candleTime = new Date(matchedAt);
        const minutes = candleTime.getUTCMinutes();

        switch (type) {
            case '1m':
                candleTime.setUTCMinutes(minutes, 0, 0);
                break;
            case '5m':
                candleTime.setUTCMinutes(Math.floor(minutes / 5) * 5, 0, 0);
                break;
            case '15m':
                candleTime.setUTCMinutes(Math.floor(minutes / 15) * 15, 0, 0);
                break;
            case '30m':
                candleTime.setUTCMinutes(Math.floor(minutes / 30) * 30, 0, 0);
                break;
            case '1h':
                candleTime.setUTCMinutes(0, 0, 0);
                break;
            case '1d':
                candleTime.setUTCHours(0, 0, 0, 0);
                break;
        }
        return candleTime;
    }

    private key(stockId: number, type: ChartType): string {
        return `${stockId}:${type}`;
    }
}
