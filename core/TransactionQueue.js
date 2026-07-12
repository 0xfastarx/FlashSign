'use strict';

class TransactionQueue {
    constructor() {
        this._queues = new Map();
    }

    enqueue(walletAddress, chainId, sessionId, txFn) {
        const key = `${walletAddress.toLowerCase()}_${chainId}`;
        const current = this._queues.get(key) || Promise.resolve();
        const next = current.then(async () => {
            console.log(`[TxQueue][${sessionId}] ▶️ Menjalankan tx wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} @ chain ${chainId}`);
            try { return await txFn(); } catch (err) { throw err; }
        });
        this._queues.set(key, next.catch(() => { }));
        next.finally(() => {
            if (this._queues.get(key) === next.catch(() => { })) this._queues.delete(key);
        });
        return next;
    }

    isQueued(walletAddress, chainId) {
        return this._queues.has(`${walletAddress.toLowerCase()}_${chainId}`);
    }
}
const globalTxQueue = new TransactionQueue();

module.exports = { TransactionQueue, globalTxQueue };