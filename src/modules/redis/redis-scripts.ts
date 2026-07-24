// TODO

// KEYS[1] = rt:loaded:order:{acc}
// KEYS[2] = rt:openOrders:{acc}
// KEYS[3] = rt:filledOrders:{acc}
// ARGV[1] = 주문 JSON 배열 [{ id, tab: 'o'|'f', fields: { ... } }]
// ARGV[2] = 주문 본체 키 프리픽스 (rt:order:)
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
        redis.call('ZADD', KEYS[2], order.id, order.id)
    else
        redis.call('ZADD', KEYS[3], order.id, order.id)
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
