import type { IndexProgress, IndexResult } from './indexer';

type IndexReply =
	| { id: number; result: IndexResult }
	| { id: number; error: string }
	| { progress: IndexProgress };

export class IndexerClient {
	private worker: Worker;
	private workerUrl: string;
	private nextId = 0;
	private failure: Error | undefined;
	private pending = new Map<number, {
		resolve: (result: IndexResult) => void;
		reject: (error: Error) => void;
	}>();

	constructor(workerPath: string, private onProgress?: (progress: IndexProgress | null) => void) {
		const source = `require(${JSON.stringify(workerPath)});`;
		this.workerUrl = URL.createObjectURL(
			new Blob([source], { type: 'text/javascript' }),
		);
		this.worker = new Worker(this.workerUrl);
		this.worker.addEventListener('message', (event: MessageEvent<IndexReply>) => {
			const reply = event.data;
			if ('progress' in reply) {
				if (this.pending.size > 0) this.onProgress?.(reply.progress);
				return;
			}
			const request = this.pending.get(reply.id);
			if (request === undefined) return;
			this.pending.delete(reply.id);

			if ('error' in reply) request.reject(new Error(reply.error));
			else request.resolve(reply.result);
			if (this.pending.size === 0) this.onProgress?.(null);
		});
		this.worker.addEventListener('error', (event) => {
			this.rejectPending(new Error(event.message));
		});
	}

	indexVault(vaultPath: string, ignoredPaths: string[]): Promise<IndexResult> {
		if (this.failure !== undefined) return Promise.reject(this.failure);

		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { resolve, reject });
			if (this.pending.size === 1) this.onProgress?.({ phase: 'scanning' });
			this.worker.postMessage({ id, vaultPath, ignoredPaths });
		});
	}

	stop(): void {
		this.rejectPending(new Error('Indexer worker stopped.'));
		this.worker.terminate();
		URL.revokeObjectURL(this.workerUrl);
	}

	private rejectPending(error: Error): void {
		this.failure = error;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		this.onProgress?.(null);
	}
}
