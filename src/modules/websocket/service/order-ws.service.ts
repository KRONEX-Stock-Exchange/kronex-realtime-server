import { Injectable } from '@nestjs/common';
import { OrderStatus, OrderType, TradingType } from '@prisma/client';
import { Server } from 'socket.io';
import { RealtimeOrderState, RealtimeStockInfo } from '../type/realtime-state.type';
import { getAccountRoomName } from './account-ws.service';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';

interface OrderPayload {
    id: string;
    stockId: number;
    stockName?: string;
    price: string;
    quantity: string;
    filledQuantity: string;
    tradingType: TradingType;
    status: OrderStatus;
    orderType?: OrderType;
    createdAt?: Date;
}

@Injectable()
export class OrderWsService {
    private server: Server;

    constructor(private readonly state: RealtimeStateService) {}

    setServer(server: Server): void {
        this.server = server;
    }

    // 초기 주문 데이터 전송 (체결, 미체결 주문)
    async sendOrderInit(accountId: number): Promise<void> {
        await this.sendOpenOrders(accountId);
        await this.sendFilledOrders(accountId);
    }

    // 미체결 주문 현황 전송
    async sendOpenOrders(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const orders = await this.state.order.getOpenOrders(accountId);
        const data = await this.serializeOrders(orders);

        this.server.to(roomName).emit('openOrdersUpdated', data);
    }

    // 체결 주문 현황 전송
    async sendFilledOrders(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const orders = await this.state.order.getFilledOrders(accountId);
        const data = await this.serializeOrders(orders);

        this.server.to(roomName).emit('filledOrdersUpdated', data);
    }

    private async serializeOrders(orders: RealtimeOrderState[]): Promise<OrderPayload[]> {
        const stocks = await this.getStocks(orders);
        return orders.map((order) => serializeOrder(order, stocks.get(order.stockId)));
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

// util
function serializeOrder(
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
    };
}
