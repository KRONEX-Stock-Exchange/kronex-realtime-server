# 프론트엔드 WebSocket 연동 가이드

KRONEX 실시간 서버(Socket.IO)와 프론트엔드가 연동할 때 필요한 사항을 정리한 문서.

- 전송 라이브러리: **Socket.IO** (순수 WebSocket 아님 — 클라이언트도 `socket.io-client` 사용)
- Namespace: **`/stock`**
- 기본 포트: **`3001`** (`REALTIME_SERVER_PORT` 환경변수로 변경 가능)
- CORS: 모든 오리진 허용

---

## 1. 연결 & 인증

인증은 **JWT 액세스 토큰**으로 하며, 반드시 **`handshake.auth.token`** 에 담아야 한다 (쿼리스트링/헤더 아님).

```ts
import { io } from 'socket.io-client';

const socket = io('http://<host>:3001/stock', {
    auth: { token: accessToken }, // JWT AccessToken
    transports: ['websocket'],
});
```

- 토큰이 유효하지 않으면 **연결은 되지만** 이후 메시지 핸들러 진입 시점에 가드(`WsGuard`)가 막고 `errorCustom` 이벤트를 내려준다.
- 토큰 payload의 `userId`가 계좌 인가(`joinAccountRoom`)에 사용된다.

### 인증 실패 이벤트 (`errorCustom`)

가드에서 토큰 검증 실패 시 클라이언트로 `errorCustom`을 emit 한다.

```ts
socket.on('errorCustom', (err: { message: string }) => {
    // err.message 예시:
    // "AccessToken이 누락되었습니다."
    // "AccessToken이 만료되었습니다."
    // "AccessToken이 유효하지 않습니다."
});
```

---

## 2. 에러 처리

에러 채널은 두 가지다.

| 채널 | 언제 | 페이로드 |
|---|---|---|
| `errorCustom` | 토큰 인증 실패 (가드 단계) | `{ message: string }` |
| `exception` | 메시지 핸들러 처리 중 예외 (NestJS `WsException` 기본 채널) | `{ message: string, errorCode: string }` |

```ts
socket.on('exception', (err: { message: string; errorCode: string }) => { ... });
```

### 핸들러 에러 코드

| errorCode | 상황 | message |
|---|---|---|
| `WEBSOCKET_001` | 존재하지 않는 계좌 | 존재하지 않는 계좌 입니다. |
| `WEBSOCKET_002` | 계좌 접근 권한 없음 (소유자 불일치 / userId 없음) | 접근 권한이 없습니다. |
| `WEBSOCKET_003` | 필수 파라미터 누락 (payload가 null 등) | 필수 파라미터가 누락되었습니다. |

---

## 3. 방(Room) 개념

데이터는 **방 단위 구독**으로 전달된다. 방에 입장(`join*`)하면:

1. 그 즉시 **초기 데이터**(`*Init` 계열)를 한 번 받고,
2. 이후 해당 데이터가 바뀔 때마다 **갱신 이벤트**(`*Updated` 계열)를 받는다.

> ⚠️ **리스너를 먼저 등록한 뒤 join 하라.** 초기 데이터는 join 직후 서버가 곧바로 emit 하므로, `on(...)` 등록이 늦으면 초기 스냅샷을 놓친다.

| 방 종류 | 입장 이벤트 | 내부 room 이름 |
|---|---|---|
| 종목 상세 | `joinStockRoom` | `stock_{stockId}` |
| 종목 가격만 | `joinStockPriceRoom` | `stock_price_{stockId}` |
| 계좌 | `joinAccountRoom` | `account_{accountId}` |
| 차트 | `joinChartRoom` | `chart_{stockId}_{type}` |

---

## 4. Client → Server (emit)

| 이벤트 | payload | 효과 |
|---|---|---|
| `joinStockRoom` | `stockId: number` | 종목방 입장 → `stockInfoUpdated` · `orderBookUpdated` · `matchedListUpdated` 초기 전송 |
| `leaveStockRoom` | `stockId: number` | 종목방 퇴장 |
| `joinStockPriceRoom` | `stockId: number` | 가격 전용방 입장 (초기 전송 없음, 이후 `stockPriceUpdated`만) |
| `leaveStockPriceRoom` | `stockId: number` | 가격 전용방 퇴장 |
| `joinAccountRoom` | `accountId: number` | **인가 검사 후** 입장 → `accountInit` + `openOrdersUpdated` · `filledOrdersUpdated` 초기 전송 |
| `leaveAccountRoom` | `accountId: number` | 계좌방 퇴장 |
| `joinChartRoom` | `{ stockId: number, type: ChartType, from?: string }` | 차트방 입장 → `chartInit` 전송 |
| `leaveChartRoom` | `{ stockId: number, type: ChartType }` | 차트방 퇴장 |

> `joinStockRoom`/`joinStockPriceRoom`/`join·leaveAccountRoom` 등은 payload가 **숫자 하나**다. 객체가 아니다.
> 예: `socket.emit('joinStockRoom', 900001)`
>
> 차트 이벤트만 payload가 **객체**다.
> 예: `socket.emit('joinChartRoom', { stockId: 900001, type: '1m', from: '2026-07-01T00:00:00.000Z' })`
> - `from`(선택): 이 시각 이후의 완성 봉을 초기 데이터로 함께 내려준다. 생략 시 진행 중인 현재 봉만.

---

## 5. Server → Client (on)

### 5-1. 종목 상세 방 (`joinStockRoom`)

#### `stockInfoUpdated` — 종목 기본 정보
```ts
{
  id: number;
  name: string;
  price: string;        // 현재가
  prevClose: string;    // 전일 종가
  open: string;
  high: string;
  low: string;
  close: string;
  upperLimit: string;   // 상한가
  lowerLimit: string;   // 하한가
}
```

#### `orderBookUpdated` — 호가창
```ts
{
  buyOrderbook:  { price: string; quantity: string }[];  // 매수 호가 (높은 가격 우선, 최대 10)
  sellOrderbook: { price: string; quantity: string }[];  // 매도 호가 (낮은 가격 우선, 최대 10)
}
```

#### `matchedListUpdated` — 체결 현황
```ts
{
  price: string;
  quantity: string;
  type: 'BUY' | 'SELL';
}[]
```

### 5-2. 종목 가격 전용 방 (`joinStockPriceRoom`)

#### `stockPriceUpdated` — 현재가만
```ts
string  // 가격 문자열 (예: "17850")
```

### 5-3. 계좌 방 (`joinAccountRoom`)

#### `accountInit` — 초기 계좌 스냅샷 (입장 직후 1회)
```ts
{
  account: SerializedAccount | null;
  holdings: SerializedHolding[];
}
```

#### `accountBalanceUpdated` — 잔고 갱신
```ts
SerializedAccount | null
```

#### `holdingUpdated` — 보유 종목 1건 갱신
```ts
SerializedHolding
// 해당 종목을 전량 매도해 보유하지 않게 되면 quantity 등이 "0"인 형태로 내려온다.
```

#### `openOrdersUpdated` — 미체결 주문 목록
```ts
OrderPayload[]  // 생성순(order id 오름차순)
```

#### `filledOrdersUpdated` — 체결 주문 목록
```ts
OrderPayload[]  // 최신순(order id 내림차순), 최대 25건
```

### 5-4. 차트 방 (`joinChartRoom`)

#### `chartInit` — 초기 캔들 목록 (입장 직후 1회)
```ts
CandlePayload[]  // candleTime 오름차순 정렬
```

#### `chartUpdated` — 진행 중인 캔들 갱신
```ts
CandlePayload
```

---

## 6. 공통 데이터 타입

### SerializedAccount
```ts
{
  id: number;
  accountNumber?: number;
  balance: string;           // 총 잔고
  availableBalance: string;  // 주문 가능 잔고
}
```

### SerializedHolding
```ts
{
  stockId: number;
  quantity: string;          // 보유 수량
  availableQuantity: string; // 매도 가능 수량
  average: string;           // 평균 매입가
  totalBuyAmount: string;    // 총 매입 금액
  stock?: {
    id: number;
    name: string;
    price: string;           // 현재가
  };
}
```

### OrderPayload
```ts
{
  id: string;                // 주문 ID (BigInt → 문자열)
  stockId: number;
  stockName?: string;
  price: string;
  quantity: string;
  filledQuantity: string;    // 체결된 수량
  tradingType: 'BUY' | 'SELL' | 'EDIT' | 'CANCEL';
  status: 'RECEIVED' | 'OPEN' | 'FILLED' | 'CANCELED' | 'REPLACED' | 'REJECTED' | 'COMPLETED';
  orderType?: 'LIMIT' | 'MARKET';
  createdAt?: string;        // ISO 8601 (Date 직렬화)
}
```

### CandlePayload
```ts
{
  candleTime: string;  // ISO 8601, 봉 시작 시각
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;      // 거래량
}
```

### ChartType
```ts
'1m' | '5m' | '15m' | '30m' | '1h' | '1d'
```

---

## 7. 주의사항

- **금액·수량·가격은 전부 `string`이다.** 서버 내부가 `BigInt`라 JSON 직렬화 시 문자열로 나간다. 프론트에서 `BigInt(...)` 또는 정밀 계산 라이브러리로 파싱할 것. (`Number()`로 바꾸면 큰 값에서 정밀도 손실 위험)
- **ID 구분:** `order.id`는 문자열, `stockId`/`accountId`는 숫자다.
- **리스너 등록 → join 순서**를 지킬 것 (초기 스냅샷 유실 방지).
- **갱신 이벤트는 구독자가 있을 때만 발행된다.** 방에 아무도 없으면 서버는 emit 자체를 건너뛴다(정상 동작).
- `accountBalanceUpdated`, `accountInit.account`는 계좌 정보가 없을 때 **`null`** 이 올 수 있다.
- 계좌 방 입장은 **JWT의 userId와 계좌 소유자가 일치**해야 한다. 불일치 시 `exception`(`WEBSOCKET_002`).
- 재연결 시 Socket.IO는 방 구독을 자동 복원하지 않는다. **reconnect 이후 필요한 `join*`을 다시 emit** 해야 한다.
