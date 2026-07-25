# KRONEX Realtime Redis 상태 관리

## 핵심 값

```text
DB cursor (Mysql에 저장되어있음)
→ DB에 완전히 반영된 마지막 outputSeq

Redis cursor (Redis에 저장되어있음)
→ Redis에 완전히 반영된 마지막 outputSeq

MQ cursor (Mysql에 저장되어있음)
→ MQ가 발행 완료한 최신 outputSeq
```

Redis 구조:

```text
rt:meta = { cursor: 100, schemaVersion: 1 }   Hash   Redis에 반영된 마지막 outputSeq

# 종목
rt:stock:{stockId}              Hash   name, price, status
rt:orderbook:{stockId}          Hash   B:{price} / S:{price} = 수량
rt:orderbook:{stockId}:buy      ZSet   member=price (score=price, 매수 정렬)
rt:orderbook:{stockId}:sell     ZSet   member=price (score=price, 매도 정렬)

# 계좌
rt:account:{accountId}          Hash   balance, availableBalance, accountNumber, userId
rt:holding:{accountId}:{stockId} Hash  quantity, availableQuantity, average, totalBuyAmount
rt:holdings:{accountId}         Set    member=stockId (보유 종목 인덱스)

# 주문
rt:order:{orderId}              Hash   id, accountId, stockId, price, quantity, filledQuantity, status, ...
rt:openOrders:{accountId}       ZSet   member=orderId (score=orderId, 미체결)
rt:filledOrders:{accountId}     ZSet   member=orderId (score=orderId, 체결)

# 적재 완료 마커 (아래 3번 참고)
rt:loaded:order:{accountId}     String 주문 목록 DB 적재 완료
rt:loaded:holding:{accountId}   String 보유 목록 DB 적재 완료
rt:loaded:orderbook:{stockId}   String 호가창 DB 적재 완료
```

Realtime Server는 총 3가지의 케이스로 나뉜다.

## 1. 일반 흐름

```text
RabbitMQ EventBatch 수신
→ outputSeq=N 확인 만약에 RedisCursor >= N이라면 즉시 ACK (중복)
→ 이벤트별 Redis 명령 생성
→ Redis MULTI/EXEC 실행
    → 이벤트에 따른 상태 및 인덱스 값 업데이트
→ 모든 명령 성공 확인
→ Redis cursor 업데이트
→ ACK
→ 클라이언트에게 값 전송
```

Redis 실패시:

```text
MULTI/EXEC 또는 cursor 업데이트 실패
→ 랜덤한 시간 간격으로 점차 재시도 간격을 늘려가며 재시도
→ Consumer 중지 및 메세지 ACK 금지
→ Redis 복구시 정상 처리 후 메세지 ACK
```

## 2. 서버 부팅 시 ✅

서버는 onMoudleInit으로 서버 준비 완료까지 요청을 받지 않도록한다.

```text
서버 시작
→ readiness=false
    → 클라이언트 상태 요청 차단
    → RabbitMQ Consumer 중지
→ Redis Cursor 조회 후 로컬 캐시로 저장
→ RabbitMQ Consumer 재게
→ 서버 준비 완료
→ RabbitMQ Consumer 메세지 소비 및 ACK
→ 클라이언트 전송

미리 데이터 로드 할 필요 X (호가창은 밑에 내용 처럼 DB 조회 해서 redis 저장)
```

## 3. Redis에 값이 없을 때 (DB 폴백)

Redis는 콜드스타트/일부 데이터 부재 시 DB에서 조회해 적재한다. 읽기(gateway)·쓰기(consumer)
양쪽이 폴백을 탈 수 있으며, 둘 다 다음 규칙으로 동작한다.

### 3-1. "빈 값"과 "미적재" 구분

Redis 값이 비어있는 게 **정상적으로 없는 것**인지 **아직 DB에서 안 읽어온 것**인지 구분해야 한다.
DB를 매번 다시 치지 않기 위함이다. 도메인 구조에 따라 두 방식을 쓴다.

- **인덱스(Set/ZSet) 기반 — 주문 / 보유 / 호가창**
  목록이 정상적으로 빌 수 있다(주문 없는 계좌, 호가 없는 종목). 빈 인덱스와 미적재가 모호하므로
  **별도 마커 키**(`rt:loaded:*`)를 둔다. 마커 존재 = 적재 완료.
  - 마커 있음 + 인덱스 비어있음 → 진짜로 없음 → DB 재조회 X
  - 마커 없음 + 인덱스 비어있음 → 미적재 → DB 조회 후 적재

- **단일 Hash 기반 — 종목 / 계좌**
  종목/계좌는 존재하면 항상 특정 필드를 가진다. **이벤트에는 안 실리고 DB에만 있는 필드**를
  적재 완료 신호로 쓴다(별도 마커 불필요).
  - 종목: `rt:stock:{id}`의 `name` 필드 존재 여부 (`HEXISTS name`)
  - 계좌: `rt:account:{id}`의 `userId` 필드 존재 여부 (`HEXISTS userId`)

### 3-2. 적재는 Lua로 (경쟁 가드)

읽기·쓰기가 동시에 같은 데이터의 적재를 시도할 수 있다. `적재 여부 검사 → DB 적재`를
원자적으로 묶어야 중복 적재/덮어쓰기가 없다. MULTI는 큐잉만 해서 값을 읽고 판단할 수 없으므로
**Lua(`EVAL`)** 로 처리한다.

```text
Lua 내부
→ 마커/신호 필드 재검증 (EXISTS rt:loaded:* / HEXISTS name·userId)
    → 이미 적재됨 → 아무것도 안 하고 return 0
    → 미적재 → 본체 HSET + 인덱스 ZADD/SADD + 마커 SET → return 1
```

이 재검증 덕분에 어느 경로가 먼저 실행되든 적재는 한 번만 일어나고, 늦은 쪽은 기존 데이터를
덮지 않는다.

### 3-3. 읽기(get) 경로

```text
클라이언트 요청
→ Redis 조회

값 존재 (인덱스 있음 / Hash 완전)
→ Redis 값 전송

값 없음
→ 마커/신호로 "미적재" 확인
    → 적재됨(마커 있음) → 빈 값(빈 목록 / NOT_FOUND) 반환
    → 미적재 → DB 조회 → Lua 적재 → DB 값 반환
→ 적재(Lua) 실패는 삼키고 DB 값은 그대로 반환 (캐싱 실패 ≠ 조회 실패)
```

### 3-4. 쓰기(apply) 경로 — load-first

이벤트에는 일부 필드가 없다(주문 `orderType`/`createdAt`, 종목 `name`, 계좌 `userId`/`accountNumber`).
미적재 상태에서 이벤트만 반영하면 불완전한 값이 남으므로, **적재를 먼저 하고 그 위에 이벤트를 덮는다.**

```text
이벤트 apply
→ 미적재면 DB 조회 → Lua 적재 (완전한 base 구성)
→ 이벤트 필드를 multi에 큐잉 (base 위에 덮어씀)
→ 적재(Lua) 실패는 throw → applyWithRetry가 재시도, 최종 실패 시 nack(requeue)
    (적재 실패 상태로 이벤트를 반영하면 순서가 깨지므로 반드시 throw)
```

> DB는 Redis보다 갱신이 느리다. base를 DB에서 채워도 이벤트가 그 위를 최신 값으로 덮으므로,
> DB의 낡은 `price`/`balance` 등이 남지 않는다.

## 4. Redis 설정

```text
maxmemory 설정
→ maxmemory-policy noeviction
→ 상태 키 TTL 사용 금지
→ AOF 활성화
```

```conf
maxmemory 8gb
maxmemory-policy noeviction
appendonly yes
```

메모리가 가득 찬 경우:

```text
기존 상태 키는 유지
→ 신규 write 실패
→ RabbitMQ ACK 금지
→ Consumer 중지
→ 메모리 복구 후 동일 이벤트 재처리
```
