import {
    RealtimeMatchedTradeState,
    RealtimeTradeState,
} from '../../type/realtime-state.type';

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
}

export class TradeRealtimeState {
    private readonly tradesByStock = new Map<number, TradeRingBuffer>();
    private readonly matchedTradesByStock = new Map<
        number,
        RealtimeMatchedTradeState[]
    >();

    add(trade: RealtimeTradeState): boolean {
        let trades = this.tradesByStock.get(trade.stockId);
        if (!trades) {
            trades = new TradeRingBuffer(50);
            this.tradesByStock.set(trade.stockId, trades);
        }
        const added = trades.push(trade);
        if (added) this.matchedTradesByStock.delete(trade.stockId);
        return added;
    }

    getMatched(stockId: number): RealtimeMatchedTradeState[] | undefined {
        return this.matchedTradesByStock.get(stockId);
    }

    setMatched(stockId: number, trades: RealtimeMatchedTradeState[]): void {
        this.matchedTradesByStock.set(stockId, trades);
    }
}
