import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { EVENT_BATCH_PATTERN } from '../serializer/event-batch.deserializer';
import { DomainEvent, EventBatch } from '../type/event.type';
import { RealtimeOrderState } from '../type/realtime-state.type';
import { AccountWsService } from '../service/account-ws.service';
import { ChartWsService } from '../service/chart-ws.service';
import { OrderWsService } from '../service/order-ws.service';
import { RealtimeStateService } from '../service/realtime-state.service';
import { StockWsService } from '../service/stock-ws.service';
import { RedisStateService } from 'src/modules/redis/redis-state.service';

// Redis 장애 등 일시적 실패에 대한 재시도 설정
const EVENT_RETRY = {
    count: 5,
    baseDelayMs: 100,
    maxDelayMs: 5000,
};

// TODO: 프로세스 재시작시 큐 데이터가 중복 전달되면 Chart와 Trade가 중복 적용될 수 있음
// Redis 적용 필요
@Controller()
export class EventConsumer {
    private readonly logger = new Logger(EventConsumer.name);

    constructor(
        private readonly state: RealtimeStateService,
        private readonly stockWsService: StockWsService,
        private readonly accountWsService: AccountWsService,
        private readonly orderWsService: OrderWsService,
        private readonly chartWsService: ChartWsService,
        private readonly redisState: RedisStateService,
    ) {}

    @EventPattern(EVENT_BATCH_PATTERN)
    async handleEventBatch(@Payload() batch: EventBatch, @Ctx() context: RmqContext) {
        const channel = context.getChannelRef();
        const message = context.getMessage();

        try {
            const outputSeq = BigInt(batch.outputSeq);

            if (outputSeq <= this.redisState.getCursor()) {
                channel.ack(message);
                return;
            }

            await this.applyWithRetry(batch.events, outputSeq);
            channel.ack(message);
        } catch (error) {
            this.logger.error(
                `Event batch processing failed (inputSeq=${batch?.inputSeq}, outputSeq=${batch?.outputSeq})`,
                error instanceof Error ? error.stack : error,
            );

            channel.nack(message, false, true);
        }
    }

    private async applyWithRetry(
        events: DomainEvent[],
        outputSeq: bigint,
    ): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.applyAndPublish(events, outputSeq);
                return;
            } catch (error) {
                if (attempt >= EVENT_RETRY.count) throw error;

                const backoffMs = Math.min(
                    EVENT_RETRY.baseDelayMs * 2 ** attempt,
                    EVENT_RETRY.maxDelayMs,
                );
                const delayMs = backoffMs / 2 + Math.random() * (backoffMs / 2);

                this.logger.warn(
                    `Event batch 처리 실패, 재시도 (outputSeq=${outputSeq}, retry=${attempt + 1}/${EVENT_RETRY.count}, delay=${Math.round(delayMs)}ms)`,
                );
                await this.sleep(delayMs);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 상태 반영 후 변경된 데이터를 클라이언트에게 발행
    private async applyAndPublish(
        events: DomainEvent[],
        outputSeq: bigint,
    ): Promise<void> {
        // 데이터 중복 처리 방지용
        let stockId: number | undefined;
        let updateStockInfo = false;
        let updateOrderBook = false;
        let updateMatchedList = false;
        let updateChart = false;
        const orderUpdates = new Map<number, RealtimeOrderState[]>();
        const accounts = new Set<number>();
        const holdings = new Set<string>();

        // Redis 트랜잭션
        const multi = this.state.createBatch();

        // 이벤트 상태 반영 및 갱신 대상 수집
        for (const event of events) {
            const orderState = await this.state.applyEvent(event, multi);

            switch (event.pattern) {
                case 'trade.executed':
                    stockId = Number(event.data.stockId);
                    updateStockInfo = true;
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
                case 'order.canceled':
                case 'order.replaced': {
                    const accountId = Number(event.data.accountId);
                    stockId = Number(event.data.stockId);
                    if (orderState) {
                        const list = orderUpdates.get(accountId) ?? [];
                        list.push(orderState);
                        orderUpdates.set(accountId, list);
                    }
                    break;
                }
                case 'orderbook.updated':
                    stockId = Number(event.data.stockId);
                    updateOrderBook = true;
                    break;
                case 'account.updated':
                case 'account.activated':
                    accounts.add(Number(event.data.id));
                    break;
                case 'holding.updated':
                    holdings.add(`${event.data.accountId}:${event.data.stockId}`);
                    break;
                case 'order.rejected':
                case 'order.completed':
                    break;
            }
        }

        await this.state.commitBatch(multi);
        await this.redisState.commitCursor(outputSeq);

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
                tasks.push(this.stockWsService.sendMatchedTrades(stockId));
            }
        }
        orderUpdates.forEach((orders, accountId) =>
            tasks.push(this.orderWsService.sendOrder(accountId, orders)),
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

// :3
