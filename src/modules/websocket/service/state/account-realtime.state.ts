import {
    RealtimeAccountState,
    RealtimeHoldingState,
} from '../../type/realtime-state.type';

type AccountState = RealtimeAccountState & {
    userId?: number;
};

export class AccountRealtimeState {
    private readonly accounts = new Map<number, AccountState>();
    private readonly holdingsByAccountId = new Map<
        number,
        Map<number, RealtimeHoldingState>
    >();

    applyAccountUpdate(account: AccountState): void {
        this.accounts.set(account.id, {
            ...this.accounts.get(account.id),
            ...account,
        });
    }

    applyHoldingUpdate(holding: RealtimeHoldingState): void {
        const holdings = this.holdingsByAccountId.get(holding.accountId);

        if (holding.quantity === 0n && holding.availableQuantity === 0n) {
            holdings?.delete(holding.stockId);
            if (holdings?.size === 0) {
                this.holdingsByAccountId.delete(holding.accountId);
            }
            return;
        }

        const accountHoldings = holdings ?? new Map<number, RealtimeHoldingState>();
        accountHoldings.set(holding.stockId, {
            ...accountHoldings.get(holding.stockId),
            ...holding,
        });
        this.holdingsByAccountId.set(holding.accountId, accountHoldings);
    }

    getAccount(accountId: number): AccountState | undefined {
        const account = this.accounts.get(accountId);
        return account ? { ...account } : undefined;
    }

    getFirstAccountByUserId(userId: number): AccountState | undefined {
        for (const account of this.accounts.values()) {
            if (account.userId === userId) return { ...account };
        }
        return undefined;
    }

    getHolding(accountId: number, stockId: number): RealtimeHoldingState | undefined {
        const holding = this.holdingsByAccountId.get(accountId)?.get(stockId);
        return holding ? { ...holding } : undefined;
    }

    getHoldings(accountId: number): RealtimeHoldingState[] {
        const holdings = this.holdingsByAccountId.get(accountId);
        return holdings ? [...holdings.values()].map((holding) => ({ ...holding })) : [];
    }
}
