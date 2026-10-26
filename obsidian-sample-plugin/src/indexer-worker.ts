import {
	getIndexedFilesForVault,
	indexVault,
	runChecksForVault,
	setIgnoredPaths,
	type IndexProgress,
	type LinkResolution,
	type LinkTargetQuery,
	type ResolveLinkTargets,
	type RunChecksResult,
} from './indexer';
import type { RulesConfig } from './rules-config';

interface IndexRequest {
	id: number;
	vaultPath: string;
	configDir: string;
	databasePath?: string;
	ignoredPaths: string[];
	ignoredFilePaths: string[];
}

interface IndexedFilesRequest {
	id: number;
	type: 'get-indexed-files';
	vaultPath: string;
	configDir: string;
}

interface RunChecksRequest {
	id: number;
	type: 'run-checks';
	vaultPath: string;
	configDir: string;
	config: RulesConfig;
}

type WorkerMessage = IndexRequest
	| IndexedFilesRequest
	| RunChecksRequest
	| { id: number; type: 'resolve-links-result'; resolution: LinkResolution }
	| { id: number; type: 'resolve-links-error'; error: string };

const pendingResolutions = new Map<number, {
	resolve: (resolution: LinkResolution) => void;
	reject: (error: Error) => void;
}>();

self.onmessage = ({ data: message }: MessageEvent<WorkerMessage>) => {
	if ('type' in message) {
		if (message.type === 'get-indexed-files') {
			void runGetIndexedFilesRequest(message);
			return;
		}
		if (message.type === 'run-checks') {
			void runRunChecksRequest(message);
			return;
		}
		const pending = pendingResolutions.get(message.id);
		if (pending === undefined) return;
		pendingResolutions.delete(message.id);
		if (message.type === 'resolve-links-result') pending.resolve(message.resolution);
		else pending.reject(new Error(message.error));
		return;
	}
	void runIndexRequest(message);
};

async function runIndexRequest(request: IndexRequest): Promise<void> {
	try {
		setIgnoredPaths(request.ignoredPaths);
		const resolveLinks: ResolveLinkTargets = (queries: LinkTargetQuery[]) => new Promise((resolve, reject) => {
			pendingResolutions.set(request.id, { resolve, reject });
			try {
				self.postMessage({ id: request.id, type: 'resolve-links', queries });
			} catch (error) {
				pendingResolutions.delete(request.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		const result = await indexVault(
			request.vaultPath,
			request.configDir,
			request.databasePath,
			(progress: IndexProgress) => self.postMessage({ progress }),
			resolveLinks,
			request.ignoredFilePaths,
		);
		self.postMessage({ id: request.id, result });
	} catch (error) {
		self.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function runGetIndexedFilesRequest(request: IndexedFilesRequest): Promise<void> {
	try {
		const files = await getIndexedFilesForVault(request.vaultPath, request.configDir);
		self.postMessage({ id: request.id, type: 'indexed-files-result', files });
	} catch (error) {
		self.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function runRunChecksRequest(request: RunChecksRequest): Promise<void> {
	try {
		const result: RunChecksResult = await runChecksForVault(request.vaultPath, request.configDir, request.config);
		self.postMessage({ id: request.id, type: 'run-checks-result', result });
	} catch (error) {
		self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
}
