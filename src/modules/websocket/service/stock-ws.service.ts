import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { calcStockLimit } from 'src/common/helpers/stock-limit';
import {
    RealtimeMatchedTradeState,
    RealtimeOrderBook,
    RealtimeOrderBookLevel,
    RealtimeStockInfo,
} from '../type/realtime-state.type';
import { ChartWsService } from './chart-ws.service';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';
import { StockLimitService } from './stock-limit.service';

interface StockInfoPayload {
    id: number;
    name: string;
    price: string;
    prevClose: string;
    low: string;
    high: string;
    close: string;
    open: string;
    upperLimit: string;
    lowerLimit: string;
}

interface OrderBookLevelPayload {
    price: string;
    quantity: string;
}

interface OrderBookPayload {
    buyOrderbook: OrderBookLevelPayload[];
    sellOrderbook: OrderBookLevelPayload[];
}

interface MatchedTradePayload {
    price: string;
    quantity: string;
    type: RealtimeMatchedTradeState['tradingType'];
}

@Injectable()
export class StockWsService {
    private server: Server;

    constructor(
        private readonly chartWsService: ChartWsService,
        private readonly stockLimitService: StockLimitService,
        private readonly state: RealtimeStateService,
    ) {}

    setServer(server: Server): void {
        this.server = server;
    }

    // 초기 종목 정보 전송 (기본정보, 호가창, 체결 현황)
    async sendStockInit(stockId: number): Promise<void> {
        await this.sendStockInfo(stockId);
        await this.sendOrderBook(stockId);
        await this.sendMatchedTrades(stockId);
    }

    // 종목 정보 현황 전송
    async sendStockInfo(stockId: number): Promise<void> {
        const roomName = getStockRoomName(stockId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const data = await this.getStockInfo(stockId);
        if (!data) return;

        this.server.to(roomName).emit('stockInfoUpdated', data);
    }

    // 호가창 현황 전송
    async sendOrderBook(stockId: number): Promise<void> {
        const roomName = getStockRoomName(stockId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const orderBook = await this.state.stock.getOrderBook(stockId);
        const data = serializeOrderBook(orderBook);

        this.server.to(roomName).emit('orderBookUpdated', data);
    }

    // 체결 현황 전송
    async sendMatchedTrades(stockId: number): Promise<void> {
        const roomName = getStockRoomName(stockId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const matchedTrades = this.state.trade.getMatchedTrades(stockId);
        const data = matchedTrades.map(serializeMatchedTrade);

        this.server.to(roomName).emit('matchedListUpdated', data);
    }

    // 주식 가격 현황 전송
    async sendStockPrice(stockId: number): Promise<void> {
        const roomName = getStockPriceRoomName(stockId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const price = await this.state.stock.getPrice(stockId);
        if (price == null) return;

        const data = price.toString();
        this.server.to(roomName).emit('stockPriceUpdated', data);
    }

    private async getStock(stockId: number): Promise<RealtimeStockInfo | null> {
        return (await this.state.stock.getInfo(stockId)) ?? null;
    }

    private async getStockInfo(stockId: number): Promise<StockInfoPayload | null> {
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
}

// utill
export function getStockRoomName(stockId: number): string {
    return `stock_${stockId}`;
}

export function getStockPriceRoomName(stockId: number): string {
    return `stock_price_${stockId}`;
}

function serializeMatchedTrade(trade: RealtimeMatchedTradeState): MatchedTradePayload {
    return {
        price: trade.price.toString(),
        quantity: trade.quantity.toString(),
        type: trade.tradingType,
    };
}

function serializeOrderBook(orderBook?: RealtimeOrderBook): OrderBookPayload {
    return {
        buyOrderbook: (orderBook?.buyLevels ?? []).map(serializeOrderBookLevel),
        sellOrderbook: (orderBook?.sellLevels ?? []).map(serializeOrderBookLevel),
    };
}

function serializeOrderBookLevel(level: RealtimeOrderBookLevel): OrderBookLevelPayload {
    return {
        price: level.price.toString(),
        quantity: level.quantity.toString(),
    };
}
