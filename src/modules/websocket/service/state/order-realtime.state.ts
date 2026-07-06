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
    set(order: RealtimeOrderState): void {
        const openOrders = this.openOrdersByAccount.get(order.accountId);
        const filledOrders = this.filledOrdersByAccount.get(order.accountId);
        const currentOpenOrder = openOrders?.get(order.id);

        // Open Order 업데이트 및 제거
        if (openOrders && order.status === OrderStatus.OPEN) {
            openOrders.set(order.id, { ...currentOpenOrder, ...order });
        } else if (openOrders) {
            openOrders.delete(order.id);
        }

        // Filled일 경우
        if (filledOrders && order.filledQuantity > 0n) {
            filledOrders.set(order.id, {
                ...currentOpenOrder,
                ...filledOrders.get(order.id),
                ...order,
            });
        }
    }

    getOpenOrders(accountId: number): RealtimeOrderState[] | undefined {
        const orders = this.openOrdersByAccount.get(accountId);
        return orders ? [...orders.values()] : undefined;
    }

    getFilledOrders(accountId: number): RealtimeOrderState[] | undefined {
        const orders = this.filledOrdersByAccount.get(accountId);
        return orders ? [...orders.values()] : undefined;
    }

    setOpenOrders(accountId: number, orders: RealtimeOrderState[]): void {
        this.openOrdersByAccount.set(
            accountId,
            new Map(orders.map((order) => [order.id, order])),
        );
    }

    setFilledOrders(accountId: number, orders: RealtimeOrderState[]): void {
        this.filledOrdersByAccount.set(
            accountId,
            new Map(orders.map((order) => [order.id, order])),
        );
    }
}
