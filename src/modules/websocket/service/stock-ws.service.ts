import { Injectable } from '@nestjs/common';
import { CursorType, Prisma, StockStatus } from '@prisma/client';
import { CustomSocket } from '../interface/custom-socket.interface';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { Server } from 'socket.io';
import { ChartWsService } from './chart-ws.service';
import { StockLimitService } from './stock-limit.service';
import { calcStockLimit } from 'src/common/helpers/stock-limit';
import { hasRoomMembers } from './socket-room.util';
import { RealtimeStateService } from './realtime-state.service';
import {
    RealtimeMatchedTradeState,
    RealtimeOrderBookLevelState,
    RealtimeOrderBookState,
    RealtimeStockInfo,
} from '../type/realtime-state.type';

type BigIntInput = bigint | number | string | { toString(): string };

type OrderBookRow = {
    side: 'BUY' | 'SELL';
    price: BigIntInput;
    quantity: BigIntInput | null;
};

@Injectable()
export class StockWsService {
    private server: Server;
    private readonly orderBookLoadPromises = new Map<
        number,
        Promise<RealtimeOrderBookState>
    >();

    constructor(
        private readonly prismaService: PrismaService,
        private readonly chartWsService: ChartWsService,
        private readonly stockLimitService: StockLimitService,
        private readonly state: RealtimeStateService,
    ) {}

    async setServer(server: Server) {
        this.server = server;
    }

    // join / leave
    async onJoinStockRoom(stockId: number, client: CustomSocket) {
        const stock = await this.getStock(stockId);

        if (!stock || stock.status === StockStatus.PENDING) {
            client.emit('error', { message: 'STOCK_NOT_TRADABLE' });
            return;
        }

        client.join(this.stockRoom(stockId));

        // 초기 데이터 전송
        this.sendStockInfo(stockId);
        this.sendOrderBook(stockId);
        this.sendMatchedList(stockId);
    }

    onLeaveStockRoom(stockId: number, client: CustomSocket) {
        client.leave(this.stockRoom(stockId));
    }

    onJoinStockPriceRoom(stockId: number, client: CustomSocket) {
        client.join(this.stockPriceRoom(stockId));
    }

    onLeaveStockPriceRoom(stockId: number, client: CustomSocket) {
        client.leave(this.stockPriceRoom(stockId));
    }

    // 가격 및 호가창에 대한 정보 전송
    async sendStockInfo(stockId: number) {
        if (!hasRoomMembers(this.server, this.stockRoom(stockId))) return;

        const data = await this.getStockInfo(stockId);
        if (!data) return;

        this.server.to(this.stockRoom(stockId)).emit('stockInfoUpdated', data);
    }

    // 호가창 데이터 전송
    async sendOrderBook(stockId: number) {
        if (!hasRoomMembers(this.server, this.stockRoom(stockId))) return;

        const data = await this.getOrderBook(stockId);

        this.server.to(this.stockRoom(stockId)).emit('orderBookUpdated', data);
    }

    // 체결 기록 전송
    async sendMatchedList(stockId: number) {
        if (!hasRoomMembers(this.server, this.stockRoom(stockId))) return;

        const matchedList = await this.getMatchedList(stockId);

        this.server.to(this.stockRoom(stockId)).emit('matchedListUpdated', matchedList);
    }

    // 프론트에서 계좌 연산을 위한 주식 가격 전송
    async sendStockPrice(stockId: number) {
        if (!hasRoomMembers(this.server, this.stockPriceRoom(stockId))) return;

        const stock = await this.getStock(stockId);
        if (!stock) return;

        this.server
            .to(this.stockPriceRoom(stockId))
            .emit('stockPriceUpdated', stock.price.toString());
    }

    private async getStock(stockId: number): Promise<RealtimeStockInfo | null> {
        const cached = this.state.stock.getInfo(stockId);
        if (cached) return cached;

        const stock = await this.prismaService.stock.findUnique({
            where: { id: stockId },
            select: { id: true, name: true, price: true, status: true },
        });
        if (!stock) return null;

        this.state.stock.setInfo(stock);
        return stock;
    }

    private async getStockInfo(stockId: number) {
        const stock = await this.getStock(stockId);
        if (!stock) return null;

        const todayCandle = await this.chartWsService.recoverCurrentCandle(stockId, '1d');
        const prevCloseRaw = await this.stockLimitService.getPrevClose(stockId);
        if (prevCloseRaw == null) return null;

        const limits = calcStockLimit(Number(prevCloseRaw));
        const prevClose = prevCloseRaw.toString();
        return {
            id: stock.id,
            name: stock.name,
            price: stock.price.toString(),
            prevClose,
            low: todayCandle?.low.toString() ?? prevClose,
            high: todayCandle?.high.toString() ?? prevClose,
            close: todayCandle?.close.toString() ?? prevClose,
            open: todayCandle?.open.toString() ?? prevClose,
            upperLimit: limits.upperLimit.toString(),
            lowerLimit: limits.lowerLimit.toString(),
        };
    }

    private async getOrderBook(stockId: number) {
        const orderBook = await this.getOrLoadOrderBook(stockId);
        return this.serializeOrderBook(orderBook);
    }

    private async getOrLoadOrderBook(stockId: number): Promise<RealtimeOrderBookState> {
        const cached = this.state.stock.getOrderBook(stockId);
        if (cached) return cached;

        const loading = this.orderBookLoadPromises.get(stockId);
        if (loading) return loading;

        const loadPromise = this.loadOrderBook(stockId)
            .then((loaded) => {
                const current = this.state.stock.getOrderBook(stockId);
                if (current && current.outputSeq > loaded.outputSeq) return current;

                this.state.stock.setOrderBook(loaded);
                return this.state.stock.getOrderBook(stockId) ?? loaded;
            })
            .finally(() => {
                this.orderBookLoadPromises.delete(stockId);
            });

        this.orderBookLoadPromises.set(stockId, loadPromise);
        return loadPromise;
    }

    private async loadOrderBook(stockId: number): Promise<RealtimeOrderBookState> {
        return this.prismaService.$transaction(
            async (tx) => {
                const rows = await tx.$queryRaw<OrderBookRow[]>`
                    SELECT
                        trading_type AS side,
                        price,
                        SUM(quantity - filled_quantity) AS quantity
                    FROM orders
                    WHERE
                        stock_id = ${stockId}
                        AND trading_type IN ('BUY', 'SELL')
                        AND status = 'OPEN'
                    GROUP BY trading_type, price
                    HAVING quantity > 0
                `;

                const cursor = await tx.cursor.findUnique({
                    where: { type: CursorType.DB_APPLIED_OUTPUT_SEQ },
                    select: { index: true },
                });

                return this.toOrderBookState(
                    stockId,
                    cursor?.index ?? 0n,
                    rows.map((row) => ({
                        side: row.side,
                        price: this.toBigInt(row.price),
                        quantity: row.quantity == null ? 0n : this.toBigInt(row.quantity),
                    })),
                );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
    }

    private toOrderBookState(
        stockId: number,
        outputSeq: bigint,
        levels: RealtimeOrderBookLevelState[],
    ): RealtimeOrderBookState {
        const buyLevels = new Map<bigint, bigint>();
        const sellLevels = new Map<bigint, bigint>();

        for (const level of levels) {
            const sideLevels = level.side === 'BUY' ? buyLevels : sellLevels;
            sideLevels.set(level.price, level.quantity);
        }

        return { stockId, outputSeq, buyLevels, sellLevels };
    }

    private async getMatchedList(stockId: number) {
        const cached = this.state.trade.getMatched(stockId);
        if (cached) {
            return cached.map((trade) => this.serializeMatchedTrade(trade));
        }

        const rows = await this.prismaService.trade.findMany({
            where: { stockId },
            orderBy: { matchedAt: 'desc' },
            take: 50,
            select: {
                price: true,
                quantity: true,
                takerOrder: { select: { tradingType: true } },
            },
        });
        const trades: RealtimeMatchedTradeState[] = rows.map((row) => ({
            price: row.price,
            quantity: row.quantity,
            tradingType: row.takerOrder.tradingType,
        }));
        this.state.trade.setMatched(stockId, trades);
        return trades.map((trade) => this.serializeMatchedTrade(trade));
    }

    // utill
    private stockRoom(stockId: number) {
        return `stock_${stockId}`;
    }

    private stockPriceRoom(stockId: number) {
        return `stock_price_${stockId}`;
    }

    private serializeMatchedTrade(trade: RealtimeMatchedTradeState) {
        return {
            price: trade.price.toString(),
            quantity: trade.quantity.toString(),
            type: trade.tradingType,
        };
    }

    private serializeOrderBook(orderBook: RealtimeOrderBookState) {
        return {
            buyOrderbook: this.serializeOrderBookLevels(orderBook.buyLevels, 'desc'),
            sellOrderbook: this.serializeOrderBookLevels(orderBook.sellLevels, 'asc'),
        };
    }

    private serializeOrderBookLevels(
        levels: Map<bigint, bigint>,
        direction: 'asc' | 'desc',
    ) {
        // WHAT THE
        return [...levels.entries()]
            .filter(([, quantity]) => quantity > 0n)
            .sort(([a], [b]) => {
                if (a === b) return 0;
                if (direction === 'asc') return a < b ? -1 : 1;
                return a > b ? -1 : 1;
            })
            .slice(0, 10)
            .map(([price, quantity]) => ({
                price: price.toString(),
                quantity: quantity.toString(),
            }));
    }

    private toBigInt(value: BigIntInput): bigint {
        return BigInt(value.toString());
    }
}
