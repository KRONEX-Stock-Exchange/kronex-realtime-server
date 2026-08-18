import { Injectable } from '@nestjs/common';
import { OrderStatus, OrderType, TradingType } from '@prisma/client';
import { Server } from 'socket.io';
import { RealtimeOrderState, RealtimeStockInfo } from '../type/realtime-state.type';
import { getAccountRoomName } from './account-ws.service';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';

export interface OrderPayload {
    id: string;
    stockId: number;
    stockName?: string;
    price: string;
    quantity: string;
    filledQuantity: string;
    tradingType: TradingType;
    status: OrderStatus;
    orderType?: OrderType;
    createdAt: Date | null;
    fullyFilledAt: Date | null;
}

@Injectable()
export class OrderWsService {
    private server: Server;

    constructor(private readonly state: RealtimeStateService) {}

    setServer(server: Server): void {
        this.server = server;
    }

    // 업데이트된 주문 데이터 전송
    async sendOrder(accountId: number, orders: RealtimeOrderState[]): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const data = await this.serializeOrders(orders);
        this.server.to(roomName).emit('orderUpdated', data);
    }

    // 초기 주문 데이터 전송 (체결, 미체결 주문)
    async sendOrderInit(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);

        const { orders: openOrders } = await this.fetchOpenOrdersPage(accountId);
        const { orders: filledOrders } = await this.fetchFilledOrdersPage(accountId);

        this.server.to(roomName).emit('openOrdersInit', openOrders);
        this.server.to(roomName).emit('filledOrdersInit', filledOrders);
    }

    // 미체결 주문 커서 페이지 조회
    async fetchOpenOrdersPage(
        accountId: number,
        cursor?: string,
        limit?: number,
    ): Promise<{ orders: OrderPayload[]; nextCursor: string | null }> {
        const { orders, nextCursor } = await this.state.order.getOpenOrders(
            accountId,
            cursor,
            limit,
        );
        return { orders: await this.serializeOrders(orders), nextCursor };
    }

    // 체결 주문 커서 페이지 조회
    async fetchFilledOrdersPage(
        accountId: number,
        cursor?: string,
        limit?: number,
    ): Promise<{ orders: OrderPayload[]; nextCursor: string | null }> {
        const { orders, nextCursor } = await this.state.order.getFilledOrders(
            accountId,
            cursor,
            limit,
        );
        return { orders: await this.serializeOrders(orders), nextCursor };
    }

    private async serializeOrders(orders: RealtimeOrderState[]): Promise<OrderPayload[]> {
        const stocks = await this.getStocks(orders);
        return orders.map((order) =>
            this.serializeOrder(order, stocks.get(order.stockId)),
        );
    }

    private serializeOrder(
        order: RealtimeOrderState,
        stock?: RealtimeStockInfo,
    ): OrderPayload {
        return {
            id: order.id.toString(),
            stockId: order.stockId,
            stockName: stock?.name,
            price: order.price.toString(),
            quantity: order.quantity.toString(),
            filledQuantity: order.filledQuantity.toString(),
            orderType: order.orderType,
            tradingType: order.tradingType,
            status: order.status,
            createdAt: order.createdAt,
            fullyFilledAt: order.fullyFilledAt,
        };
    }

    // 주문 목록에 등장하는 종목만 중복 없이 조회
    private async getStocks(
        orders: RealtimeOrderState[],
    ): Promise<Map<number, RealtimeStockInfo | undefined>> {
        const stockIds = [...new Set(orders.map((order) => order.stockId))];
        const infos = await Promise.all(
            stockIds.map((stockId) => this.state.stock.getInfo(stockId)),
        );
        return new Map(stockIds.map((stockId, index) => [stockId, infos[index]]));
    }
}
