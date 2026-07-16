import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { RealtimeOrderState } from '../type/realtime-state.type';
import { getAccountRoomName } from './account-ws.service';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';

@Injectable()
export class OrderWsService {
    private server: Server;

    constructor(private readonly state: RealtimeStateService) {}

    setServer(server: Server): void {
        this.server = server;
    }

    // 초기 주문 데이터 전송
    async sendOrderInit(accountId: number): Promise<void> {
        await this.sendOpenOrders(accountId);
        await this.sendFilledOrders(accountId);
    }

    // 미체결 주문 전송
    async sendOpenOrders(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const orders = this.state.order.getOpenOrders(accountId);
        const data = orders.map(serializeOrder);

        this.server.to(roomName).emit('openOrdersUpdated', data);
    }

    // 체결 주문 전송
    async sendFilledOrders(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const orders = this.state.order.getFilledOrders(accountId);
        const data = orders.map(serializeOrder);

        this.server.to(roomName).emit('filledOrdersUpdated', data);
    }
}

// utill
function serializeOrder(order: RealtimeOrderState) {
    return {
        id: order.id.toString(),
        stockId: order.stockId,
        stockName: order.stockName,
        price: order.price.toString(),
        quantity: order.quantity.toString(),
        filledQuantity: order.filledQuantity.toString(),
        orderType: order.orderType,
        tradingType: order.tradingType,
        status: order.status,
        createdAt: order.createdAt,
    };
}
