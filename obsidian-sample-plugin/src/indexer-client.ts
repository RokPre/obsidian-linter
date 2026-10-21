import type {
	IndexProgress,
	IndexResult,
	LinkResolution,
	LinkTargetQuery,
	LinkTargetSelection,
} from './indexer';
import { isIgnoredVaultPath } from './ignored-paths';

interface ObsidianIndexHost {
	getFiles(): Array<{ path: string }>;
	getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null;
}

type IndexReply =
	| { id: number; result: IndexResult }
	| { id: number; error: string }
	| { id: number; type: 'resolve-links'; queries: LinkTargetQuery[] }
	| { progress: IndexProgress };

interface PendingIndex {
	resolve: (result: IndexResult) => void;
	reject: (error: Error) => void;
	ignoredPaths: string[];
	configDir: string;
}

export class IndexerClient {
	private worker: Worker;
	private workerUrl: string;
	private nextId = 0;
	private failure: Error | undefined;
	private pending = new Map<number, PendingIndex>();

	constructor(
		workerPath: string,
		private host: ObsidianIndexHost,
		private onProgress?: (progress: IndexProgress | null) => void,
	) {
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
			if ('type' in reply && reply.type === 'resolve-links') {
				this.resolveLinks(reply.id, request, reply.queries);
				return;
			}

			this.pending.delete(reply.id);
			if ('error' in reply) request.reject(new Error(reply.error));
			else if ('result' in reply) request.resolve(reply.result);
			if (this.pending.size === 0) this.onProgress?.(null);
		});
		this.worker.addEventListener('error', (event) => {
			this.rejectPending(new Error(event.message));
		});
	}

	indexVault(vaultPath: string, ignoredPaths: string[], configDir: string): Promise<IndexResult> {
		if (this.failure !== undefined) return Promise.reject(this.failure);

		return new Promise((resolve, reject) => {
			const ignoredFilePaths = this.host.getFiles()
				.map(({ path }) => path)
				.filter((path) => isIgnoredVaultPath(path, ignoredPaths, configDir))
				.sort();
			const id = ++this.nextId;
			const request = { resolve, reject, ignoredPaths: [...ignoredPaths], configDir };
			this.pending.set(id, request);
			if (this.pending.size === 1) this.onProgress?.({ phase: 'scanning' });
			this.worker.postMessage({ id, vaultPath, ignoredPaths: request.ignoredPaths, ignoredFilePaths, configDir });
		});
	}

	private resolveLinks(id: number, request: PendingIndex, queries: LinkTargetQuery[]): void {
		try {
			const vaultFiles = this.host.getFiles().map(({ path }) => ({
				path,
				ignored: isIgnoredVaultPath(path, request.ignoredPaths, request.configDir),
			}));
			const uniqueQueries = new Map<string, LinkTargetQuery>();
			for (const query of queries) {
				uniqueQueries.set(JSON.stringify([query.linkpath, query.sourcePath]), query);
			}
			const selections: LinkTargetSelection[] = [...uniqueQueries.values()].map((query) => {
				const file = this.host.getFirstLinkpathDest(query.linkpath, query.sourcePath);
				return { ...query, targetPath: file?.path ?? null };
			});
			const resolution: LinkResolution = { vaultFiles, selections };
			this.worker.postMessage({ id, type: 'resolve-links-result', resolution });
		} catch (error) {
			this.worker.postMessage({
				id,
				type: 'resolve-links-error',
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
