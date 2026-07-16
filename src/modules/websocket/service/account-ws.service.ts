import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { WebsocketException } from '../error/websocket.exception';
import {
    RealtimeAccountState,
    RealtimeHoldingState,
    RealtimeStockInfo,
} from '../type/realtime-state.type';
import { RealtimeStateService } from './realtime-state.service';
import { hasRoomMembers } from './socket-room.util';

type SerializedAccount = {
    id: number;
    accountNumber?: number;
    balance: string;
    availableBalance: string;
};

type SerializedHolding = {
    stockId: number;
    quantity: string;
    availableQuantity: string;
    average: string;
    totalBuyAmount: string;
    stock?: {
        id: number;
        name: string;
        price: string;
    };
};

@Injectable()
export class AccountWsService {
    private server: Server;

    constructor(private readonly state: RealtimeStateService) {}

    setServer(server: Server): void {
        this.server = server;
    }

    validateAccountId(userId: number, accountId: number): void {
        const account = this.state.account.getAccount(accountId);
        if (!account) throw new WebsocketException('ACCOUNT_NOT_FOUND');

        if (account.userId == null || account.userId !== userId) {
            throw new WebsocketException('ACCOUNT_FORBIDDEN');
        }
    }

    async sendAccountInit(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const account = this.state.account.getAccount(accountId);
        const holdings = this.state.account.getHoldings(accountId);
        const data = {
            account: account ? serializeAccount(account) : null,
            holdings: holdings.map((holding) =>
                serializeHolding(holding, this.state.stock.getInfo(holding.stockId)),
            ),
        };

        this.server.to(roomName).emit('accountInit', data);
    }

    async sendAccountBalance(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const account = this.state.account.getAccount(accountId);
        const data = account ? serializeAccount(account) : null;

        this.server.to(roomName).emit('accountBalanceUpdated', data);
    }

    async sendHolding(accountId: number, stockId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const holding =
            this.state.account.getHolding(accountId, stockId) ??
            createEmptyHolding(accountId, stockId);
        const stock = this.state.stock.getInfo(stockId);
        const data = serializeHolding(holding, stock);

        this.server.to(roomName).emit('holdingUpdated', data);
    }
}

// utill
export function getAccountRoomName(accountId: number): string {
    return `account_${accountId}`;
}

function createEmptyHolding(accountId: number, stockId: number): RealtimeHoldingState {
    return {
        accountId,
        stockId,
        quantity: 0n,
        availableQuantity: 0n,
        average: 0n,
        totalBuyAmount: 0n,
    };
}

function serializeAccount(account: RealtimeAccountState): SerializedAccount {
    return {
        id: account.id,
        accountNumber: account.accountNumber,
        balance: account.balance.toString(),
        availableBalance: account.availableBalance.toString(),
    };
}

function serializeHolding(
    holding: RealtimeHoldingState,
    stock?: RealtimeStockInfo,
): SerializedHolding {
    return {
        stockId: holding.stockId,
        quantity: holding.quantity.toString(),
        availableQuantity: holding.availableQuantity.toString(),
        average: holding.average.toString(),
        totalBuyAmount: holding.totalBuyAmount.toString(),
        stock: stock
            ? {
                  id: stock.id,
                  name: stock.name,
                  price: stock.price.toString(),
              }
            : undefined,
    };
}
