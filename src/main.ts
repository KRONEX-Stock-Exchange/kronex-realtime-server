import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { EventBatchDeserializer } from './modules/websocket/serializer/event-batch.deserializer';

function numberConfig(
    configService: ConfigService,
    key: string,
    fallback: number,
): number {
    const value = Number(configService.get(key));
    return Number.isFinite(value) ? value : fallback;
}

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    app.enableCors({
        origin: true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );

    const configService = app.get(ConfigService);

    app.connectMicroservice<MicroserviceOptions>({
        transport: Transport.RMQ,
        options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: 'event_queue',
            queueOptions: {
                durable: true,
            },
            prefetchCount: 1,
            noAck: false,
            deserializer: new EventBatchDeserializer(),
        },
    });

    await app.startAllMicroservices();
    await app.listen(
        numberConfig(configService, 'REALTIME_SERVER_PORT', 3001),
        '0.0.0.0',
    );
}

bootstrap();
