import type {
	IndexProgress,
	IndexResult,
	LinkResolution,
	LinkTargetQuery,
	LinkTargetSelection,
	RunChecksResult,
} from './indexer';
import type { IndexedFile, RulesConfig } from './rules-config';
import { isIgnoredVaultPath } from './ignored-paths';

interface ObsidianIndexHost {
	getFiles(): Array<{ path: string }>;
	getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null;
}

type IndexReply =
	| { id: number; result: IndexResult }
	| { id: number; error: string }
	| { id: number; type: 'resolve-links'; queries: LinkTargetQuery[] }
	| { id: number; type: 'indexed-files-result'; files: IndexedFile[] }
	| { id: number; type: 'run-checks-result'; result: RunChecksResult }
	| { progress: IndexProgress };

interface PendingIndex {
	kind: 'index';
	resolve: (result: IndexResult) => void;
	reject: (error: Error) => void;
	ignoredPaths: string[];
	configDir: string;
}

interface PendingIndexedFiles {
	kind: 'files';
	resolve: (files: IndexedFile[]) => void;
	reject: (error: Error) => void;
}

interface PendingRunChecks {
	kind: 'run-checks';
	resolve: (result: RunChecksResult) => void;
	reject: (error: Error) => void;
}

type PendingRequest = PendingIndex | PendingIndexedFiles | PendingRunChecks;

export class IndexerClient {
	private worker: Worker;
	private workerUrl: string;
	private nextId = 0;
	private failure: Error | undefined;
	private pending = new Map<number, PendingRequest>();
	private pendingIndexCount = 0;

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
				if (this.pendingIndexCount > 0) this.onProgress?.(reply.progress);
				return;
			}

			const request = this.pending.get(reply.id);
			if (request === undefined) return;
			if ('type' in reply && reply.type === 'resolve-links') {
				if (request.kind === 'index') this.resolveLinks(reply.id, request, reply.queries);
				else {
					this.pending.delete(reply.id);
					request.reject(new Error('Unexpected link-resolution request for this worker request.'));
				}
				return;
			}

			this.pending.delete(reply.id);
			if ('error' in reply) request.reject(new Error(reply.error));
			else if ('result' in reply && !('type' in reply) && request.kind === 'index') request.resolve(reply.result);
			else if ('files' in reply && request.kind === 'files') request.resolve(reply.files);
			else if ('type' in reply && reply.type === 'run-checks-result' && request.kind === 'run-checks') request.resolve(reply.result);
			else request.reject(new Error('Unexpected indexer worker response.'));
			if (request.kind === 'index') {
				this.pendingIndexCount--;
				if (this.pendingIndexCount === 0) this.onProgress?.(null);
			}
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
			const request: PendingIndex = { kind: 'index', resolve, reject, ignoredPaths: [...ignoredPaths], configDir };
			this.pending.set(id, request);
			const firstIndexRequest = this.pendingIndexCount === 0;
			this.pendingIndexCount++;
			if (firstIndexRequest) this.onProgress?.({ phase: 'scanning' });
			this.worker.postMessage({ id, vaultPath, ignoredPaths: request.ignoredPaths, ignoredFilePaths, configDir });
		});
	}

	getIndexedFiles(vaultPath: string, configDir: string): Promise<IndexedFile[]> {
		if (this.failure !== undefined) return Promise.reject(this.failure);

		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { kind: 'files', resolve, reject });
			this.worker.postMessage({ id, type: 'get-indexed-files', vaultPath, configDir });
		});
	}

	runChecks(vaultPath: string, configDir: string, config: RulesConfig): Promise<RunChecksResult> {
		if (this.failure !== undefined) return Promise.reject(this.failure);

		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { kind: 'run-checks', resolve, reject });
			this.worker.postMessage({ id, type: 'run-checks', vaultPath, configDir, config });
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
		this.pendingIndexCount = 0;
		this.onProgress?.(null);
	}
}
