import {
	indexVault,
	setIgnoredPaths,
	type IndexProgress,
	type LinkResolution,
	type LinkTargetQuery,
	type ResolveLinkTargets,
} from './indexer';

interface IndexRequest {
	id: number;
	vaultPath: string;
	configDir: string;
	databasePath?: string;
	ignoredPaths: string[];
	ignoredFilePaths: string[];
}

type WorkerMessage = IndexRequest
	| { id: number; type: 'resolve-links-result'; resolution: LinkResolution }
	| { id: number; type: 'resolve-links-error'; error: string };

const pendingResolutions = new Map<number, {
	resolve: (resolution: LinkResolution) => void;
	reject: (error: Error) => void;
}>();

self.onmessage = ({ data: message }: MessageEvent<WorkerMessage>) => {
	if ('type' in message) {
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
