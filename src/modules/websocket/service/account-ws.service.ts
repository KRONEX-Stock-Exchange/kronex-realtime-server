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

    async validateAccountId(userId: number, accountId: number): Promise<void> {
        const account = await this.state.account.getAccount(accountId);
        if (!account) throw new WebsocketException('ACCOUNT_NOT_FOUND');

        if (account.userId == null || account.userId !== userId) {
            throw new WebsocketException('ACCOUNT_FORBIDDEN');
        }
    }

    // 계좌 초기 정보 전송 (잔고, 전체 보유 종목)
    async sendAccountInit(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const [account, holdings] = await Promise.all([
            this.state.account.getAccount(accountId),
            this.state.account.getHoldings(accountId),
        ]);

        const data = {
            account: account ? serializeAccount(account) : null,
            holdings: await Promise.all(
                holdings.map(async (holding) =>
                    serializeHolding(
                        holding,
                        await this.state.stock.getInfo(holding.stockId),
                    ),
                ),
            ),
        };

        this.server.to(roomName).emit('accountInit', data);
    }

    // 잔고 현황 전송
    async sendAccountBalance(accountId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const account = await this.state.account.getAccount(accountId);
        const data = account ? serializeAccount(account) : null;

        this.server.to(roomName).emit('accountBalanceUpdated', data);
    }

    // 변경된 보유 종목 현황 전송
    async sendHolding(accountId: number, stockId: number): Promise<void> {
        const roomName = getAccountRoomName(accountId);
        if (!hasRoomMembers(this.server, roomName)) return;

        const [holding, stock] = await Promise.all([
            this.state.account.getHolding(accountId, stockId),
            this.state.stock.getInfo(stockId),
        ]);
        const data = serializeHolding(
            // NOTE: holding이 비어 있는 경우는 해당 종목을 더 이상 보유 하고 있지 않을때
            holding ?? createEmptyHolding(accountId, stockId),
            stock,
        );

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
