import { Global, Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { EventConsumer } from './consumer/event.consumer';
import { StockWsService } from './service/stock-ws.service';
import { AccountWsService } from './service/account-ws.service';
import { OrderWsService } from './service/order-ws.service';
import { ChartWsService } from './service/chart-ws.service';
import { StockLimitService } from './service/stock-limit.service';
import { RealtimeStateService } from './service/realtime-state.service';

@Global()
@Module({
    imports: [],
    controllers: [EventConsumer],
    providers: [
        WebsocketGateway,
        StockWsService,
        AccountWsService,
        OrderWsService,
        ChartWsService,
        StockLimitService,
        RealtimeStateService,
    ],
    exports: [WebsocketGateway, ChartWsService],
})
export class WebsocketModule {}
