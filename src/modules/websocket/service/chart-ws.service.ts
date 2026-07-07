import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { ChartType, CHART_TYPES, CANDLE_TYPE } from 'src/modules/chart/type/chart-type';
import { CustomSocket } from '../interface/custom-socket.interface';
import { InMemoryCandle, PendingCandle } from '../type/realtime-state.type';
import { RealtimeStateService } from './realtime-state.service';

@Injectable()
export class ChartWsService implements OnModuleInit {
    private readonly logger = new Logger(ChartWsService.name);
    private server: Server;

    constructor(
        private readonly prismaService: PrismaService,
        private readonly state: RealtimeStateService,
    ) {}

    async onModuleInit() {
        await this.initializeCandles();
    }

    private async initializeCandles() {
        const stocks = await this.prismaService.stock.findMany({ select: { id: true } });

        for (const stock of stocks) {
            for (const type of CHART_TYPES) {
                await this.initializeCandleForType(stock.id, type);
            }
        }

        this.logger.log('캔들 초기화 완료');
    }

    private async initializeCandleForType(stockId: number, type: ChartType) {
        const lastCandle = await this.prismaService.candle.findFirst({
            where: { stockId, type: CANDLE_TYPE[type] },
            orderBy: { candleTime: 'desc' },
        });

        // 마지막 저장 봉이 있으면 그 봉 다음 시간부터, 없으면 전체 조회
        const fromTime = lastCandle
            ? new Date(lastCandle.candleTime.getTime() + this.getDurationMs(type))
            : new Date(0);

        const trades = await this.prismaService.trade.findMany({
            where: { stockId, matchedAt: { gte: fromTime } },
            orderBy: { matchedAt: 'asc' },
        });

        if (trades.length === 0) return;

        // trades를 캔들 시간대별로 그룹핑
        const candleMap = new Map<number, InMemoryCandle>();
        for (const trade of trades) {
            const ct = this.state.chart.getCandleTime(trade.matchedAt, type);
            const timeKey = ct.getTime();
            const existing = candleMap.get(timeKey);

            if (!existing) {
                candleMap.set(timeKey, {
                    candleTime: ct,
                    open: trade.price,
                    high: trade.price,
                    low: trade.price,
                    close: trade.price,
                    volume: trade.quantity,
                });
            } else {
                if (trade.price > existing.high) existing.high = trade.price;
                if (trade.price < existing.low) existing.low = trade.price;
                existing.close = trade.price;
                existing.volume += trade.quantity;
            }
        }

        const now = new Date();
        const currentCandleTime = this.state.chart.getCandleTime(now, type);

        // 현재 진행 중인 봉은 메모리에, 미저장 완성봉은 DB에 저장
        const currentTimeKey = currentCandleTime.getTime();
        for (const [timeKey, candle] of candleMap) {
            if (timeKey === currentTimeKey) {
                if (!this.state.chart.getCurrentCandle(stockId, type)) {
                    this.state.chart.setCurrentCandle(stockId, type, candle);
                }
            } else {
                await this.prismaService.candle.upsert({
                    where: {
                        stockId_candleTime_type: {
                            stockId,
                            candleTime: candle.candleTime,
                            type: CANDLE_TYPE[type],
                        },
                    },
                    create: {
                        stockId,
                        candleTime: candle.candleTime,
                        type: CANDLE_TYPE[type],
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume,
                    },
                    update: {
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume,
                    },
                });
            }
        }
    }

    setServer(server: Server) {
        this.server = server;
    }

    private getDurationMs(type: ChartType): number {
        switch (type) {
            case '1m':
                return 60_000;
            case '5m':
                return 300_000;
            case '15m':
                return 900_000;
            case '30m':
                return 1_800_000;
            case '1h':
                return 3_600_000;
            case '1d':
                return 86_400_000;
        }
    }

    private chartRoom(stockId: number, type: ChartType): string {
        return `chart_${stockId}_${type}`;
    }

    private serializeCandle(candle: InMemoryCandle) {
        return {
            candleTime: candle.candleTime.toISOString(),
            open: candle.open.toString(),
            high: candle.high.toString(),
            low: candle.low.toString(),
            close: candle.close.toString(),
            volume: candle.volume.toString(),
        };
    }

    async onJoinChartRoom(
        stockId: number,
        type: ChartType,
        client: CustomSocket,
        from?: Date,
    ) {
        client.join(this.chartRoom(stockId, type));

        // DB에서 from 이후 완성봉 조회
        const dbCandles = from
            ? await this.prismaService.candle.findMany({
                  where: {
                      stockId,
                      type: CANDLE_TYPE[type],
                      candleTime: { gte: from },
                  },
                  orderBy: { candleTime: 'asc' },
              })
            : [];

        const result = dbCandles.map((candle) => this.serializeCandle(candle));

        // pendingCandles에서 from 이후 봉 추가
        for (const {
            stockId: pStockId,
            type: pType,
            candle,
        } of this.state.chart.getPendingCandles()) {
            if (pStockId !== stockId || pType !== type) continue;
            if (from && candle.candleTime < from) continue;

            result.push(this.serializeCandle(candle));
        }

        // 현재 진행 중인 봉 추가 (메모리 없으면 trades로 복구)
        const current =
            this.state.chart.getCurrentCandle(stockId, type) ??
            (await this.recoverCurrentCandle(stockId, type));
        if (current) {
            result.push(this.serializeCandle(current));
        }

        // NOTE: pendingCandles 배열의 순서가 어긋난 경우 방지
        result.sort((a, b) => a.candleTime.localeCompare(b.candleTime));

        client.emit('chartInit', result);
    }

    onLeaveChartRoom(stockId: number, type: ChartType, client: CustomSocket) {
        client.leave(this.chartRoom(stockId, type));
    }

    private buildCandleFromTrades(
        candleTime: Date,
        trades: { price: bigint; quantity: bigint }[],
    ): InMemoryCandle | null {
        if (trades.length === 0) return null;
        let high = trades[0].price;
        let low = trades[0].price;
        let volume = 0n;
        for (const t of trades) {
            if (t.price > high) high = t.price;
            if (t.price < low) low = t.price;
            volume += t.quantity;
        }
        return {
            candleTime,
            open: trades[0].price,
            high,
            low,
            close: trades[trades.length - 1].price,
            volume,
        };
    }

    async recoverCurrentCandle(
        stockId: number,
        type: ChartType,
    ): Promise<InMemoryCandle | undefined> {
        const inMemory = this.state.chart.getCurrentCandle(stockId, type);
        if (inMemory) return inMemory;

        const candleTime = this.state.chart.getCandleTime(new Date(), type);
        const trades = await this.prismaService.trade.findMany({
            where: { stockId, matchedAt: { gte: candleTime } },
            orderBy: { matchedAt: 'asc' },
            select: { price: true, quantity: true },
        });

        // await 사이에 이벤트 apply가 먼저 채웠을 수 있으므로 재확인
        const inMemoryAfter = this.state.chart.getCurrentCandle(stockId, type);
        if (inMemoryAfter) return inMemoryAfter;

        const candle = this.buildCandleFromTrades(candleTime, trades);
        if (candle) {
            this.state.chart.setCurrentCandle(stockId, type, candle);
        }
        return candle ?? undefined;
    }

    async sendChartUpdates(stockId: number): Promise<void> {
        for (const type of CHART_TYPES) {
            const candle = this.state.chart.getCurrentCandle(stockId, type);
            if (!candle) continue;
            this.server
                ?.to(this.chartRoom(stockId, type))
                .emit('chartUpdated', this.serializeCandle(candle));
        }
    }

    // 현재 캔들 조회
    getCurrentCandle(stockId: number, type: ChartType): InMemoryCandle | undefined {
        return this.state.chart.getCurrentCandle(stockId, type);
    }

    // 현재 캔들 직접 등록 (외부 복구용)
    setCurrentCandle(stockId: number, type: ChartType, candle: InMemoryCandle): void {
        this.state.chart.setCurrentCandle(stockId, type, candle);
    }

    // Pending 캔들 꺼내기
    drainPending(): PendingCandle[] {
        return this.state.chart.drainPendingCandles();
    }

    // Pending 캔들 복원
    // NOTE: drain 후 DB 저장 실패시 복원용
    returnPending(candles: PendingCandle[]) {
        this.state.chart.returnPendingCandles(candles);
    }

    // 자정에 진행 중인 1d 봉을 pending으로 이동
    flushDayCandles() {
        this.state.chart.flushDayCandles();
    }
}
