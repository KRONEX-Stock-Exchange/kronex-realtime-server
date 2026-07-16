import { OrderStatus } from '@prisma/client';
import { RealtimeOrderState } from '../../type/realtime-state.type';

export class OrderRealtimeState {
    // NOTE: Account[OrderId[Order]]
    private readonly openOrdersByAccount = new Map<
        number,
        Map<bigint, RealtimeOrderState>
    >();
    private readonly filledOrdersByAccount = new Map<
        number,
        Map<bigint, RealtimeOrderState>
    >();
    private filledOrdersDate = getUtcDateKey(new Date());

    applyOrderUpdate(order: RealtimeOrderState): void {
        this.resetFilledOrdersOnDateChange();
        const openOrders = getOrCreateOrderMap(this.openOrdersByAccount, order.accountId);
        const filledOrders = getOrCreateOrderMap(
            this.filledOrdersByAccount,
            order.accountId,
        );
        const currentOpenOrder = openOrders.get(order.id);

        if (order.status === OrderStatus.OPEN) {
            openOrders.set(order.id, { ...currentOpenOrder, ...order });
        } else {
            openOrders.delete(order.id);
        }

        if (order.filledQuantity > 0n) {
            filledOrders.set(order.id, {
                ...currentOpenOrder,
                ...filledOrders.get(order.id),
                ...order,
            });
        }
    }

    getOpenOrders(accountId: number): RealtimeOrderState[] {
        const orders = this.openOrdersByAccount.get(accountId);
        return orders ? [...orders.values()].map(copyOrder) : [];
    }

    getFilledOrders(accountId: number): RealtimeOrderState[] {
        this.resetFilledOrdersOnDateChange();
        const orders = this.filledOrdersByAccount.get(accountId);
        return orders ? [...orders.values()].map(copyOrder) : [];
    }

    private resetFilledOrdersOnDateChange(): void {
        const currentDate = getUtcDateKey(new Date());
        if (currentDate === this.filledOrdersDate) return;

        this.filledOrdersByAccount.clear();
        this.filledOrdersDate = currentDate;
    }
}

// utill
function getOrCreateOrderMap(
    ordersByAccount: Map<number, Map<bigint, RealtimeOrderState>>,
    accountId: number,
): Map<bigint, RealtimeOrderState> {
    let orders = ordersByAccount.get(accountId);
    if (!orders) {
        orders = new Map();
        ordersByAccount.set(accountId, orders);
    }
    return orders;
}

function copyOrder(order: RealtimeOrderState): RealtimeOrderState {
    return {
        ...order,
        createdAt: order.createdAt ? new Date(order.createdAt.getTime()) : undefined,
    };
}

function getUtcDateKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}
