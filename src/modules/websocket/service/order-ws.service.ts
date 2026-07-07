import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { Server } from 'socket.io';
import { getUtcMidnight } from 'src/common/helpers/get-utc-midnight';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { RealtimeOrderState } from '../type/realtime-state.type';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';

@Injectable()
export class OrderWsService {
    private server: Server;

    constructor(
        private readonly prismaService: PrismaService,
        private readonly state: RealtimeStateService,
    ) {}

    setServer(server: Server) {
        this.server = server;
    }

    // 초기 주문 데이터 전송
    async sendOrderInit(accountId: number) {
        await Promise.all([
            this.sendOpenOrders(accountId),
            this.sendFilledOrders(accountId),
        ]);
    }

    // 미체결 주문 전송
    async sendOpenOrders(accountId: number) {
        if (!hasRoomMembers(this.server, this.accountRoom(accountId))) return;

        const data = await this.getOpenOrders(accountId);

        this.server.to(this.accountRoom(accountId)).emit('openOrdersUpdated', data);
    }

    // 체결 주문 전송
    async sendFilledOrders(accountId: number) {
        if (!hasRoomMembers(this.server, this.accountRoom(accountId))) return;

        const data = await this.getFilledOrders(accountId);

        this.server.to(this.accountRoom(accountId)).emit('filledOrdersUpdated', data);
    }

    private async getOpenOrders(accountId: number) {
        const cached = this.state.order.getOpenOrders(accountId);
        if (cached && cached.every((order) => this.isCompleteOrder(order))) {
            return cached.map((order) => this.serializeOrder(order));
        }

        const orders = await this.findOpenOrders(accountId);
        this.state.order.setOpenOrders(accountId, orders);
        return orders.map((order) => this.serializeOrder(order));
    }

    private async getFilledOrders(accountId: number) {
        const cached = this.state.order.getFilledOrders(accountId);
        if (cached && cached.every((order) => this.isCompleteOrder(order))) {
            return cached.map((order) => this.serializeOrder(order));
        }

        const orders = await this.findFilledOrders(accountId);
        this.state.order.setFilledOrders(accountId, orders);
        return orders.map((order) => this.serializeOrder(order));
    }

    // Fetch From DB
    private async findOpenOrders(accountId: number) {
        const orders = await this.prismaService.order.findMany({
            where: { accountId, status: OrderStatus.OPEN },
            orderBy: { createdAt: 'desc' },
            select: this.orderSelect(),
        });
        return orders.map((order) => this.toRealtimeOrder(accountId, order));
    }

    private async findFilledOrders(accountId: number) {
        const orders = await this.prismaService.order.findMany({
            where: {
                accountId,
                filledQuantity: { gt: 0 },
                createdAt: { gte: getUtcMidnight() },
            },
            orderBy: { createdAt: 'desc' },
            select: this.orderSelect(),
        });
        return orders.map((order) => this.toRealtimeOrder(accountId, order));
    }

    // Util
    private accountRoom(accountId: number) {
        return `account_${accountId}`;
    }

    private orderSelect() {
        return {
            id: true,
            stockId: true,
            price: true,
            quantity: true,
            filledQuantity: true,
            orderType: true,
            tradingType: true,
            status: true,
            createdAt: true,
            stock: { select: { name: true } },
        } as const;
    }

    private toRealtimeOrder(accountId: number, order: any): RealtimeOrderState {
        return {
            id: order.id,
            accountId,
            stockId: order.stockId,
            stockName: order.stock.name,
            price: order.price,
            quantity: order.quantity,
            filledQuantity: order.filledQuantity,
            orderType: order.orderType,
            tradingType: order.tradingType,
            status: order.status,
            createdAt: order.createdAt,
        };
    }

    private serializeOrder(order: RealtimeOrderState) {
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

    private isCompleteOrder(order: RealtimeOrderState): boolean {
        return (
            order.stockName != null &&
            order.orderType != null &&
            order.tradingType != null &&
            order.createdAt != null
        );
    }
}
