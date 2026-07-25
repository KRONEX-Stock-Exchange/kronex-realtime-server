import 'dotenv/config';
import { Logger, UseGuards } from '@nestjs/common';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { WsGuard } from './guard/ws.guard';
import { CustomSocket } from './interface/custom-socket.interface';
import { WebsocketException } from './error/websocket.exception';
import {
    getStockPriceRoomName,
    getStockRoomName,
    StockWsService,
} from './service/stock-ws.service';
import { AccountWsService, getAccountRoomName } from './service/account-ws.service';
import { OrderWsService } from './service/order-ws.service';
import { ChartWsService } from './service/chart-ws.service';
import { ChartType } from 'src/modules/chart/type/chart-type';

@UseGuards(WsGuard)
@WebSocketGateway({
    namespace: '/stock',
    cors: { origin: '*' },
})
export class WebsocketGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
    constructor(
        private readonly stockWsService: StockWsService,
        private readonly accountWsService: AccountWsService,
        private readonly orderWsService: OrderWsService,
        private readonly chartWsService: ChartWsService,
    ) {}

    @WebSocketServer() server: Server;
    private logger: Logger = new Logger('websocketGateway');

    afterInit(server: Server) {
        this.stockWsService.setServer(server);
        this.accountWsService.setServer(server);
        this.orderWsService.setServer(server);
        this.chartWsService.setServer(server);
    }

    handleConnection(client: CustomSocket) {
        this.logger.log(`Client Connected : ${client.id}`);
    }

    handleDisconnect(client: CustomSocket) {
        this.logger.log(`client Disconnected : ${client.id}`);
    }

    @SubscribeMessage('joinStockRoom')
    async onJoinStockRoom(
        @MessageBody() stockId: number,
        @ConnectedSocket() client: CustomSocket,
    ): Promise<void> {
        if (stockId == null) throw new WebsocketException('INVALID_PAYLOAD');

        await client.join(getStockRoomName(stockId));
        return this.stockWsService.sendStockInit(stockId);
    }

    @SubscribeMessage('joinStockPriceRoom')
    async onJoinStockPriceRoom(
        @MessageBody() stockId: number,
        @ConnectedSocket() client: CustomSocket,
    ): Promise<void> {
        if (stockId == null) throw new WebsocketException('INVALID_PAYLOAD');
        await client.join(getStockPriceRoomName(stockId));
    }

    @SubscribeMessage('leaveStockRoom')
    async onLeaveStockRoom(
        @MessageBody() stockId: number,
        @ConnectedSocket() client: CustomSocket,
    ): Promise<void> {
        if (stockId == null) throw new WebsocketException('INVALID_PAYLOAD');
        await client.leave(getStockRoomName(stockId));
    }

    @SubscribeMessage('leaveStockPriceRoom')
    async onLeaveStockPriceRoom(
        @MessageBody() stockId: number,
        @ConnectedSocket() client: CustomSocket,
    ): Promise<void> {
        if (stockId == null) throw new WebsocketException('INVALID_PAYLOAD');
        await client.leave(getStockPriceRoomName(stockId));
    }

    @SubscribeMessage('joinAccountRoom')
    async onJoinAccountRoom(
        @ConnectedSocket() client: CustomSocket,
        @MessageBody() accountId: number,
    ): Promise<void> {
        if (accountId == null) throw new WebsocketException('INVALID_PAYLOAD');

        const userId = client.user?.userId;
        if (userId == null) throw new WebsocketException('ACCOUNT_FORBIDDEN');

        await this.accountWsService.validateAccountId(userId, accountId);
        await client.join(getAccountRoomName(accountId));
        await this.accountWsService.sendAccountInit(accountId);

        return this.orderWsService.sendOrderInit(accountId);
    }

    @SubscribeMessage('leaveAccountRoom')
    async onLeaveAccountRoom(
        @ConnectedSocket() client: CustomSocket,
        @MessageBody() accountId: number,
    ): Promise<void> {
        if (accountId == null) throw new WebsocketException('INVALID_PAYLOAD');
        await client.leave(getAccountRoomName(accountId));
    }

    @SubscribeMessage('joinChartRoom')
    async handleJoinChartRoom(
        @ConnectedSocket() client: CustomSocket,
        @MessageBody('stockId') stockId: number,
        @MessageBody('type') type: ChartType,
        @MessageBody('from') from?: string,
    ) {
        if (stockId == null || type == null)
            throw new WebsocketException('INVALID_PAYLOAD');
        const fromDate = from ? new Date(from) : undefined;
        await this.chartWsService.onJoinChartRoom(stockId, type, client, fromDate);
    }

    @SubscribeMessage('leaveChartRoom')
    handleLeaveChartRoom(
        @ConnectedSocket() client: CustomSocket,
        @MessageBody('stockId') stockId: number,
        @MessageBody('type') type: ChartType,
    ) {
        if (stockId == null || type == null)
            throw new WebsocketException('INVALID_PAYLOAD');
        this.chartWsService.onLeaveChartRoom(stockId, type, client);
    }
}
