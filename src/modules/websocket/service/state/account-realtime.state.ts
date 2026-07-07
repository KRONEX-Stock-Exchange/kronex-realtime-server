import {
    RealtimeAccountState,
    RealtimeHoldingState,
} from '../../type/realtime-state.type';

export class AccountRealtimeState {
    private readonly accounts = new Map<number, RealtimeAccountState>();
    private readonly holdings = new Map<string, RealtimeHoldingState>();

    setAccount(account: RealtimeAccountState): void {
        this.accounts.set(account.id, {
            ...this.accounts.get(account.id),
            ...account,
        });
    }

    getAccount(accountId: number): RealtimeAccountState | undefined {
        return this.accounts.get(accountId);
    }

    setHolding(holding: RealtimeHoldingState): void {
        const key = `${holding.accountId}:${holding.stockId}`;
        this.holdings.set(key, { ...this.holdings.get(key), ...holding });
    }

    getHolding(accountId: number, stockId: number): RealtimeHoldingState | undefined {
        return this.holdings.get(`${accountId}:${stockId}`);
    }

    getHoldings(accountId: number): RealtimeHoldingState[] {
        return [...this.holdings.values()].filter(
            (holding) => holding.accountId === accountId,
        );
    }
}
