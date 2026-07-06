import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { EVENT_BATCH_PATTERN } from '../serializer/event-batch.deserializer';
import { DomainEvent, EventBatch } from '../type/event.type';
import { AccountWsService } from '../service/account-ws.service';
import { ChartWsService } from '../service/chart-ws.service';
import { OrderWsService } from '../service/order-ws.service';
import { RealtimeStateService } from '../service/realtime-state.service';
import { StockWsService } from '../service/stock-ws.service';

@Controller()
export class EventConsumer {
    private readonly logger = new Logger(EventConsumer.name);

    constructor(
        private readonly state: RealtimeStateService,
        private readonly stockWsService: StockWsService,
        private readonly accountWsService: AccountWsService,
        private readonly orderWsService: OrderWsService,
        private readonly chartWsService: ChartWsService,
    ) {}

    @EventPattern(EVENT_BATCH_PATTERN)
    async handleEventBatch(@Payload() batch: EventBatch, @Ctx() context: RmqContext) {
        const channel = context.getChannelRef();
        const message = context.getMessage();

        try {
            await this.applyAndPublish(batch.events);
            channel.ack(message);
        } catch (error) {
            this.logger.error(
                `Event batch processing failed (inputSeq=${batch?.inputSeq})`,
                error instanceof Error ? error.stack : error,
            );
            channel.nack(message, false, false);
        }
    }

    // 상태 반영 후 변경된 데이터를 클라이언트에게 발행
    private async applyAndPublish(events: DomainEvent[]): Promise<void> {
        // 데이터 중복 처리 방지용
        let stockId: number | undefined;
        let updateStockInfo = false;
        let updateOrderBook = false;
        let updateMatchedList = false;
        let updateChart = false;
        const openOrders = new Set<number>();
        const filledOrders = new Set<number>();
        const accounts = new Set<number>();
        const holdings = new Set<string>();

        // 이벤트 상태 반영 및 갱신 대상 수집
        for (const event of events) {
            this.state.applyEvent(event);

            switch (event.pattern) {
                case 'trade.executed':
                    stockId = Number(event.data.stockId);
                    updateStockInfo = true;
                    updateOrderBook = true;
                    updateMatchedList = true;
                    updateChart = true;
                    break;
                case 'stock.listed':
                case 'stock.updated':
                    stockId = Number(event.data.id);
                    updateStockInfo = true;
                    break;
                case 'order.open':
                case 'order.filled':
                case 'order.canceled': {
                    const accountId = Number(event.data.accountId);
                    stockId = Number(event.data.stockId);
                    updateOrderBook = true;
                    openOrders.add(accountId);
                    if (
                        event.pattern === 'order.filled' ||
                        Number(event.data.filledQuantity) > 0
                    ) {
                        filledOrders.add(accountId);
                    }
                    break;
                }
                case 'account.updated':
                case 'account.activated':
                    accounts.add(Number(event.data.id));
                    break;
                case 'holding.updated':
                    holdings.add(`${event.data.accountId}:${event.data.stockId}`);
                    break;
                case 'order.rejected':
                    break;
            }
        }

        // WebSocket 이벤트 발행
        const tasks: Promise<void>[] = [];
        if (stockId != null) {
            if (updateChart) {
                tasks.push(this.chartWsService.sendChartUpdates(stockId));
            }
            if (updateStockInfo) {
                tasks.push(this.stockWsService.sendStockInfo(stockId));
                tasks.push(this.stockWsService.sendStockPrice(stockId));
            }
            if (updateOrderBook) {
                tasks.push(this.stockWsService.sendOrderBook(stockId));
            }
            if (updateMatchedList) {
                tasks.push(this.stockWsService.sendMatchedList(stockId));
            }
        }
        openOrders.forEach((accountId) =>
            tasks.push(this.orderWsService.sendOpenOrders(accountId)),
        );
        filledOrders.forEach((accountId) =>
            tasks.push(this.orderWsService.sendFilledOrders(accountId)),
        );
        accounts.forEach((accountId) =>
            tasks.push(this.accountWsService.sendAccountBalance(accountId)),
        );
        holdings.forEach((key) => {
            const [accountId, stockId] = key.split(':').map(Number);
            tasks.push(this.accountWsService.sendHolding(accountId, stockId));
        });

        const results = await Promise.allSettled(tasks);
        for (const result of results) {
            if (result.status === 'rejected') {
                this.logger.error(
                    'Websocket Update Failed',
                    result.reason instanceof Error ? result.reason.stack : result.reason,
                );
            }
        }
    }
}
