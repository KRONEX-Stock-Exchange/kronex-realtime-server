import {
    RealtimeMatchedTradeState,
    RealtimeTradeState,
} from '../../type/realtime-state.type';

export class TradeRealtimeState {
    private readonly tradesByStock = new Map<number, TradeRingBuffer>();
    private readonly matchedTradesByStock = new Map<
        number,
        RealtimeMatchedTradeState[]
    >();

    applyTrade(trade: RealtimeTradeState): boolean {
        let trades = this.tradesByStock.get(trade.stockId);
        if (!trades) {
            trades = new TradeRingBuffer(50);
            this.tradesByStock.set(trade.stockId, trades);
        }

        const applied = trades.push(trade);
        if (applied) this.matchedTradesByStock.delete(trade.stockId);
        return applied;
    }

    getMatchedTrades(stockId: number): RealtimeMatchedTradeState[] {
        const matchedTrades = this.matchedTradesByStock.get(stockId);
        if (matchedTrades) return matchedTrades.map((trade) => ({ ...trade }));

        const trades = this.tradesByStock.get(stockId)?.values() ?? [];
        const projected = trades.map((trade) => ({
            price: trade.price,
            quantity: trade.quantity,
            tradingType: trade.tradingType,
        }));
        this.matchedTradesByStock.set(stockId, projected);
        return projected.map((trade) => ({ ...trade }));
    }
}

// utill
class TradeRingBuffer {
    private readonly buffer: Array<RealtimeTradeState | undefined>;
    private readonly ids = new Set<bigint>();
    private head = 0;
    private size = 0;

    constructor(private readonly capacity: number) {
        this.buffer = new Array(capacity);
    }

    push(trade: RealtimeTradeState): boolean {
        if (this.ids.has(trade.id)) return false;

        if (this.size === this.capacity) {
            const evicted = this.buffer[this.head];
            if (evicted) this.ids.delete(evicted.id);
        } else {
            this.size++;
        }

        this.buffer[this.head] = trade;
        this.ids.add(trade.id);
        this.head = (this.head + 1) % this.capacity;
        return true;
    }

    values(): RealtimeTradeState[] {
        const values: RealtimeTradeState[] = [];
        for (let offset = 0; offset < this.size; offset++) {
            const index = (this.head - 1 - offset + this.capacity) % this.capacity;
            const trade = this.buffer[index];
            if (trade) values.push(trade);
        }
        return values;
    }
}
