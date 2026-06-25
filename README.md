# Kronex Realtime Server

Kronex 거래소의 실시간 WebSocket 서버입니다.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Core APIs](#core-apis)
- [Getting Started](#getting-started)
- [Related Repositories](#related-repositories)

## Overview

Kronex는 모의 거래소 프로젝트입니다.

이 저장소는 거래 이벤트를 클라이언트에 실시간으로 전달하는 Realtime Server입니다.

#### Event Flow

```text
Kronex Engine
  -> MySQL / Event Queue
  -> Realtime Server
  -> Client (WebSocket)
```

## Features

- Socket.IO 기반 실시간 데이터 전송
- JWT 기반 WebSocket 인증
- RabbitMQ 이벤트 배치 소비
- 종목별 현재가, 호가창, 체결 목록 전송
- 계좌별 잔고, 보유 종목, 미체결 주문, 체결 주문 전송
- 체결 이벤트 기반 캔들 차트 데이터 갱신

## Tech Stack

| Category      | Technology    |
| ------------- | ------------- |
| Language      | TypeScript    |
| Framework     | NestJS        |
| ORM           | Prisma        |
| Database      | MySQL         |
| Message Queue | RabbitMQ      |
| Auth          | JWT, Passport |
| Realtime      | Socket.IO     |
| Test          | Jest          |

## Core APIs

| Direction | Event | Payload | Description |
| --- | --- | --- | --- |
| Client | `joinStockRoom` | `stockId: number` | 종목 정보 room 구독 |
| Client | `leaveStockRoom` | `stockId: number` | 종목 정보 room 구독 해제 |
| Client | `joinStockPriceRoom` | `stockId: number` | 현재가 room 구독 |
| Client | `leaveStockPriceRoom` | `stockId: number` | 현재가 room 구독 해제 |
| Client | `joinAccountRoom` | `accountId?: number` | 계좌 room 구독 |
| Client | `leaveAccountRoom` | `accountId: number` | 계좌 room 구독 해제 |
| Client | `joinChartRoom` | `{ stockId, type, from? }` | 차트 room 구독 |
| Client | `leaveChartRoom` | `{ stockId, type }` | 차트 room 구독 해제 |
| Server | `stockInfoUpdated` | - | 종목 상세 정보 업데이트 |
| Server | `stockPriceUpdated` | - | 종목 현재가 업데이트 |
| Server | `orderBookUpdated` | - | 호가창 업데이트 |
| Server | `matchedListUpdated` | - | 종목 체결 목록 업데이트 |
| Server | `accountInit` | - | 계좌 초기 데이터 전송 |
| Server | `accountBalanceUpdated` | - | 계좌 잔고 업데이트 |
| Server | `holdingUpdated` | - | 보유 종목 업데이트 |
| Server | `openOrdersUpdated` | - | 미체결 주문 업데이트 |
| Server | `filledOrdersUpdated` | - | 체결 주문 업데이트 |
| Server | `chartInit` | - | 차트 초기 데이터 전송 |
| Server | `chartUpdated` | - | 차트 데이터 업데이트 |

## Getting Started

### Prerequisites

- Node.js 20+
- MySQL
- RabbitMQ
- npm

### 1. Installation

```bash
git clone git@github.com:KRONEX-Stock-Exchange/kronex-realtime-server.git
cd kronex-realtime-server
npm install
```

### 2. Environment Variables

루트 디렉토리에 `.env` 파일을 생성하고 아래 값을 설정합니다.

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:PORT/DATABASE"
RABBITMQ_URL="amqp://USER:PASSWORD@HOST:PORT"

ACCESS_TOKEN_SECRET="access-token-secret" # API Server와 동일해야합니다
REALTIME_SERVER_PORT=3001
```

### 3. Run

```bash
# development
npm run start:dev

# production
npm run build
npm run start:prod
```
