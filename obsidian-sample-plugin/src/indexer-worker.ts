import { indexVault, setIgnoredPaths, type IndexProgress } from './indexer';

interface IndexRequest {
	id: number;
	vaultPath: string;
	configDir: string;
	databasePath?: string;
	ignoredPaths: string[];
}

	self.onmessage = async ({ data: request }: MessageEvent<IndexRequest>) => {
	try {
		setIgnoredPaths(request.ignoredPaths);
		const result = await indexVault(request.vaultPath, request.configDir, request.databasePath, (progress: IndexProgress) => {
			self.postMessage({ progress });
		});
		self.postMessage({ id: request.id, result });
	} catch (error) {
		self.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
