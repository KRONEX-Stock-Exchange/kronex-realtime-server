import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { CustomSocket } from '../interface/custom-socket.interface';
import { Server } from 'socket.io';
import { WebsocketException } from '../error/websocket.exception';
import { RealtimeStateService } from './realtime-state.service';

@Injectable()
export class AccountWsService {
    private server: Server;

    constructor(
        private readonly prismaService: PrismaService,
        private readonly state: RealtimeStateService,
    ) {}

    setServer(server: Server) {
        this.server = server;
    }

    private accountRoom(accountId: number) {
        return `account_${accountId}`;
    }

    // Join / Leave
    async onJoinAccountRoom(client: CustomSocket, accountId?: number): Promise<number> {
        const userId = client.user.userId;
        let resolvedAccountId: number;

        if (accountId) {
            const account = await this.prismaService.account.findUnique({
                where: { id: accountId },
                select: { id: true, userId: true },
            });

            if (!account) throw new WebsocketException('ACCOUNT_NOT_FOUND');
            if (account.userId !== userId)
                throw new WebsocketException('ACCOUNT_FORBIDDEN');
            resolvedAccountId = account.id;
        } else {
            // accountId 없이 들어온다면 첫번째로 생성한 계좌로 구독
            const account = await this.prismaService.account.findFirst({
                where: { userId },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            });

            if (!account) throw new WebsocketException('ACCOUNT_NOT_FOUND');
            resolvedAccountId = account.id;
        }

        client.join(this.accountRoom(resolvedAccountId));
        await this.sendAccountInit(resolvedAccountId);
        return resolvedAccountId;
    }

    onLeaveAccountRoom(client: CustomSocket, accountId: number) {
        client.leave(this.accountRoom(accountId));
    }

    // 초기 계좌 데이터 WebSocket 발행
    private async sendAccountInit(accountId: number) {
        const [account, holdings] = await Promise.all([
            this.getAccount(accountId),
            this.getHoldings(accountId),
        ]);
        const data = { account, holdings };

        this.server.to(this.accountRoom(accountId)).emit('accountInit', data);
    }

    // 잔고 데이터 WebSocket 발행
    async sendAccountBalance(accountId: number): Promise<void> {
        const data = await this.getAccount(accountId);
        if (!data) return;

        this.server.to(this.accountRoom(accountId)).emit('accountBalanceUpdated', data);
    }

    // 보유 종목 데이터 WebSocket 발행
    async sendHolding(accountId: number, stockId: number): Promise<void> {
        const data = await this.getHolding(accountId, stockId);
        if (!data) return;

        this.server.to(this.accountRoom(accountId)).emit('holdingUpdated', data);
    }

    private async getAccount(accountId: number) {
        const cached = this.state.account.getAccount(accountId);
        // NOTE: accountUpdate가 먼저 들어 올 경우에 accountNumber가 존재 하지 않기때문에 SQL 조회 필요
        if (cached?.accountNumber != null) {
            return this.serializeAccount(cached);
        }

        const row = await this.prismaService.account.findUnique({
            where: { id: accountId },
            select: {
                id: true,
                accountNumber: true,
                balance: true,
                availableBalance: true,
            },
        });
        if (!row) return null;

        this.state.account.setAccount(row);
        const account = this.state.account.getAccount(accountId);
        return account ? this.serializeAccount(account) : null;
    }

    private async getHolding(accountId: number, stockId: number) {
        const cached = this.state.account.getHolding(accountId, stockId);
        if (cached) return this.serializeHolding(cached);

        const holding = await this.prismaService.userStock.findUnique({
            where: { accountId_stockId: { accountId, stockId } },
            select: {
                accountId: true,
                stockId: true,
                quantity: true,
                availableQuantity: true,
                average: true,
                totalBuyAmount: true,
            },
        });
        if (!holding) return null;

        this.state.account.setHolding(holding);
        const cachedHolding = this.state.account.getHolding(accountId, stockId);
        return cachedHolding ? this.serializeHolding(cachedHolding) : null;
    }

    private async getHoldings(accountId: number) {
        const cached = this.state.account.getHoldings(accountId);
        if (cached.length > 0) {
            return cached.map((holding) => this.serializeHolding(holding));
        }

        const rows = await this.prismaService.userStock.findMany({
            where: { accountId },
            select: {
                stockId: true,
                quantity: true,
                availableQuantity: true,
                average: true,
                totalBuyAmount: true,
                stock: {
                    select: { id: true, name: true, price: true, status: true },
                },
            },
        });

        return rows.map((row) => {
            this.state.stock.setInfo(row.stock);
            const holding = {
                accountId,
                stockId: row.stockId,
                quantity: row.quantity,
                availableQuantity: row.availableQuantity,
                average: row.average,
                totalBuyAmount: row.totalBuyAmount,
            };
            this.state.account.setHolding(holding);

            return this.serializeHolding(holding);
        });
    }

    // Util
    private serializeAccount(account: {
        id: number;
        accountNumber?: number;
        balance: bigint;
        availableBalance: bigint;
    }) {
        return {
            id: account.id,
            accountNumber: account.accountNumber,
            balance: account.balance.toString(),
            availableBalance: account.availableBalance.toString(),
        };
    }

    private serializeHolding(holding: {
        stockId: number;
        quantity: bigint;
        availableQuantity: bigint;
        average: bigint;
        totalBuyAmount: bigint;
    }) {
        const stock = this.state.stock.getInfo(holding.stockId);
        return {
            stockId: holding.stockId,
            quantity: holding.quantity.toString(),
            availableQuantity: holding.availableQuantity.toString(),
            average: holding.average.toString(),
            totalBuyAmount: holding.totalBuyAmount.toString(),
            stock: stock && {
                id: stock.id,
                name: stock.name,
                price: stock.price.toString(),
            },
        };
    }
}
