// TODO

// KEYS[1] = rt:stock:{stockId}   (Hash  name, price, status)
// ARGV[1] = name, ARGV[2] = price, ARGV[3] = status
// name 필드 존재 = 적재 완료 신호 (종목은 항상 name/price/status를 다 가지므로 별도 마커 불필요)
// price/status는 이벤트가 덮으므로 이미 적재됐으면(name 존재) 건드리지 않는다.
export const LOAD_STOCK_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'name') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'name', ARGV[1], 'price', ARGV[2], 'status', ARGV[3])
return 1
`;

// KEYS[1] = rt:account:{accountId}   (Hash  balance, availableBalance, accountNumber, userId)
// ARGV[1] = balance, ARGV[2] = availableBalance, ARGV[3] = accountNumber, ARGV[4] = userId
// userId 필드 존재 = 적재 완료 신호 (인가에 필요하고 이벤트엔 안 실리므로 마커 대용)
// balance/availableBalance는 이벤트가 덮으므로 이미 적재됐으면(userId 존재) 건드리지 않는다.
export const LOAD_ACCOUNT_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], 'userId') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'balance', ARGV[1], 'availableBalance', ARGV[2], 'accountNumber', ARGV[3], 'userId', ARGV[4])
return 1
`;

// KEYS[1] = rt:loaded:order:{acc}
// KEYS[2] = rt:openOrders:{acc}
// KEYS[3] = rt:filledOrders:{acc}
// ARGV[1] = 주문 JSON 배열 [{ id, tab: 'o'|'f', score, fields: { ... } }]
// ARGV[2] = 주문 본체 키 프리픽스 (rt:order:)
// score: open은 order.id, filled는 fullyFilledAt(epoch ms, 없으면 order.id)
export const LOAD_ORDERS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end

local orders = cjson.decode(ARGV[1])
for i = 1, #orders do
    local order = orders[i]
    local args = {}
    for field, value in pairs(order.fields) do
        args[#args + 1] = field
        args[#args + 1] = value
    end
    if #args > 0 then
        redis.call('HSET', ARGV[2] .. order.id, unpack(args))
    end
    if order.tab == 'o' then
        redis.call('ZADD', KEYS[2], order.score, order.id)
    else
        redis.call('ZADD', KEYS[3], order.score, order.id)
    end
end

redis.call('SET', KEYS[1], '1')
return 1
`;

// KEYS[1] = rt:loaded:orderbook:{stockId}
// KEYS[2] = rt:orderbook:{stockId}        (Hash  B:{price}/S:{price} = 수량)
// KEYS[3] = rt:orderbook:{stockId}:buy    (ZSet  member=price / score=price)
// KEYS[4] = rt:orderbook:{stockId}:sell   (ZSet  member=price / score=price)
// ARGV[1] = 호가 JSON 배열 [{ side: 'BUY'|'SELL', price, quantity }]  (문자열)
export const LOAD_ORDERBOOK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end

local levels = cjson.decode(ARGV[1])
for i = 1, #levels do
    local level = levels[i]
    if level.side == 'BUY' then
        redis.call('HSET', KEYS[2], 'B:' .. level.price, level.quantity)
        redis.call('ZADD', KEYS[3], level.price, level.price)
    else
        redis.call('HSET', KEYS[2], 'S:' .. level.price, level.quantity)
        redis.call('ZADD', KEYS[4], level.price, level.price)
    end
end

redis.call('SET', KEYS[1], '1')
return 1
`;

// KEYS[1] = rt:loaded:holding:{acc}
// KEYS[2] = rt:holdings:{acc}
// ARGV[1] = 보유 JSON 배열 [{ stockId, fields: { ... } }]
// ARGV[2] = 보유 본체 키 프리픽스 (rt:holding:{acc}:)
export const LOAD_HOLDINGS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end

local holdings = cjson.decode(ARGV[1])
for i = 1, #holdings do
    local holding = holdings[i]
    local args = {}
    for field, value in pairs(holding.fields) do
        args[#args + 1] = field
        args[#args + 1] = value
    end
    if #args > 0 then
        redis.call('HSET', ARGV[2] .. holding.stockId, unpack(args))
    end
    redis.call('SADD', KEYS[2], holding.stockId)
end

redis.call('SET', KEYS[1], '1')
return 1
`;
